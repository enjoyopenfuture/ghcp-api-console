import type {
  HttpHeaderPair,
  ProxyErrorDiagnosticBodyDto,
  ProxyErrorDiagnosticDetailDto,
  ProxyErrorDiagnosticRecordDto,
  ProxyErrorDiagnosticRequestDto,
  ProxyErrorDiagnosticResponseDto,
  ProxyErrorDiagnosticSummaryDto,
} from '@ghcp/shared';

const BEGIN_PREFIX = '===== GHCP PROXY ERROR DIAGNOSTIC BEGIN ';
const END_PREFIX = '===== GHCP PROXY ERROR DIAGNOSTIC END ';
const METADATA_PREFIX = 'Metadata: ';

export function formatDiagnosticRecord(record: ProxyErrorDiagnosticRecordDto): string {
  const summary = toDiagnosticSummary(record);
  const sections = [
    `${BEGIN_PREFIX}${record.id} =====`,
    `${METADATA_PREFIX}${JSON.stringify(summary)}`,
    '',
    '## Summary',
    `Timestamp: ${record.timestamp}`,
    `Diagnostic ID: ${record.id}`,
    `Failure kind: ${record.failureKind}`,
    `Identity: ${record.identity}`,
    `Path: ${record.path}`,
    `Model: ${record.model ?? '-'}`,
    `Redacted: ${record.redacted}`,
    '',
    formatRequest('Inbound request', record.inboundRequest, record.id, true),
    '',
    formatRequest('Actual upstream request', record.upstreamRequest, record.id, false),
  ];
  if (record.upstreamResponse) sections.push('', formatResponse(record.upstreamResponse));
  if (record.error) {
    sections.push(
      '',
      '## Transport / stream error',
      `Name: ${record.error.name}`,
      `Message: ${record.error.message}`,
      `Cause: ${record.error.cause ?? '-'}`,
      '',
      '[STACK]',
      record.error.stack ?? '-',
    );
  }
  sections.push('', `${END_PREFIX}${record.id} =====`, '');
  return sections.join('\n');
}

export function parseDiagnosticLog(content: string): ProxyErrorDiagnosticDetailDto[] {
  const records: ProxyErrorDiagnosticDetailDto[] = [];
  const beginPattern = /^===== GHCP PROXY ERROR DIAGNOSTIC BEGIN ([0-9a-f-]+) =====$/gm;
  for (;;) {
    const begin = beginPattern.exec(content);
    if (!begin) break;
    const id = begin[1]!;
    const blockStart = begin.index;
    const bodyStart = beginPattern.lastIndex + 1;
    const endMarker = `\n${END_PREFIX}${id} =====`;
    const endIndex = content.indexOf(endMarker, bodyStart);
    if (endIndex === -1) continue;
    const blockEnd = endIndex + endMarker.length;
    const block = content.slice(blockStart, content[blockEnd] === '\n' ? blockEnd + 1 : blockEnd);
    const metadataLineEnd = content.indexOf('\n', bodyStart);
    if (metadataLineEnd === -1 || metadataLineEnd > endIndex) continue;
    const metadataLine = content.slice(bodyStart, metadataLineEnd);
    if (!metadataLine.startsWith(METADATA_PREFIX)) continue;
    try {
      const summary = JSON.parse(metadataLine.slice(METADATA_PREFIX.length)) as ProxyErrorDiagnosticSummaryDto;
      if (summary.id !== id) continue;
      records.push({ ...summary, content: block });
    } catch {
      continue;
    }
  }
  return records;
}

export function toDiagnosticSummary(record: ProxyErrorDiagnosticRecordDto): ProxyErrorDiagnosticSummaryDto {
  return {
    id: record.id,
    timestamp: record.timestamp,
    failureKind: record.failureKind,
    identity: record.identity,
    path: record.path,
    model: record.model,
    status: record.upstreamResponse?.status,
    redacted: record.redacted,
    inboundRequestBodyBytes: record.inboundRequest.body?.byteLength ?? 0,
    upstreamRequestBodyBytes: record.upstreamRequest.body?.byteLength ?? 0,
    upstreamResponseBodyBytes: record.upstreamResponse?.body?.byteLength ?? 0,
  };
}

function formatRequest(
  title: string,
  request: ProxyErrorDiagnosticRequestDto,
  diagnosticId: string,
  inbound: boolean,
): string {
  const url = inbound ? absoluteInboundUrl(request) : request.url;
  return [
    `## ${title}`,
    '',
    '[CURL]',
    formatCurl(request, url, diagnosticId),
    '',
    '[REQUEST LINE]',
    `${request.method} ${request.url}`,
    '',
    '[HEADERS]',
    formatHeaders(request.headers),
    '',
    formatBody(request.body),
  ].join('\n');
}

function formatResponse(response: ProxyErrorDiagnosticResponseDto): string {
  return [
    '## Upstream response',
    '',
    '[STATUS]',
    `HTTP ${response.status} ${response.statusText}`.trimEnd(),
    '',
    '[HEADERS]',
    formatHeaders(response.headers),
    '',
    formatBody(response.body),
  ].join('\n');
}

function formatHeaders(headers: HttpHeaderPair[]): string {
  return headers.length > 0
    ? headers.map((header) => `${header.name}: ${header.value}`).join('\n')
    : '(none)';
}

function formatBody(body: ProxyErrorDiagnosticBodyDto | undefined): string {
  if (!body) return '[BODY]\n(none)';
  const details = [
    `encoding=${body.encoding}`,
    `observedBytes=${body.byteLength}`,
    `storedBytes=${body.capturedByteLength}`,
    `complete=${body.complete}`,
    `truncated=${body.truncated}`,
  ].join(', ');
  if (body.encoding === 'unavailable') {
    return `[BODY ${details}]\n${body.unavailableReason ?? '(unavailable)'}`;
  }
  if (!body.data) return `[BODY ${details}]\n(empty)`;
  if (body.encoding === 'base64') {
    return `[BODY ${details}]\n[Binary body encoded as base64]\n${body.data}`;
  }
  return `[BODY ${details}]\n${prettyJson(body.data)}`;
}

function formatCurl(request: ProxyErrorDiagnosticRequestDto, url: string, diagnosticId: string): string {
  const command = [`curl ${shellQuote(url)}`, `  -X ${shellQuote(request.method)}`];
  for (const header of request.headers) {
    const normalized = header.name.toLowerCase();
    if (normalized === 'host' || normalized === 'content-length') continue;
    command.push(`  -H ${shellQuote(`${header.name}: ${header.value}`)}`);
  }
  if (!request.body?.data) return command.join(' \\\n');
  if (request.body.encoding === 'utf8') {
    const delimiter = `GHCP_DIAGNOSTIC_BODY_${diagnosticId.replaceAll('-', '_')}`;
    command.push(`  --data-binary @- <<'${delimiter}'`);
    return `${command.join(' \\\n')}\n${prettyJson(request.body.data)}\n${delimiter}`;
  }
  if (request.body.encoding === 'base64') {
    return `printf %s ${shellQuote(request.body.data)} | base64 -d | ${command.join(' \\\n')} \\\n  --data-binary @-`;
  }
  return `${command.join(' \\\n')}\n# Body unavailable: ${request.body.unavailableReason ?? 'unknown reason'}`;
}

function absoluteInboundUrl(request: ProxyErrorDiagnosticRequestDto): string {
  if (/^https?:\/\//i.test(request.url)) return request.url;
  const host = headerValue(request.headers, 'host') ?? 'localhost:3000';
  const protocol = headerValue(request.headers, 'x-forwarded-proto')?.split(',')[0]?.trim() || 'http';
  return `${protocol}://${host}${request.url.startsWith('/') ? request.url : `/${request.url}`}`;
}

function headerValue(headers: HttpHeaderPair[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), undefined, 2);
  } catch {
    return value;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
