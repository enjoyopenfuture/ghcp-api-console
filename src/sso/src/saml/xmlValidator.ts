import { DOMParser } from '@xmldom/xmldom';

const SAML_PROTOCOL_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';

/**
 * samlify schema validator for the only inbound message this IdP parses: an SP-initiated AuthnRequest.
 *
 * It replaces @authenio/samlify-node-xmllint, whose per-call emscripten runtime leaked process-level
 * listeners (each retaining a 16MB heap) and could call process.exit() once stdout drained.
 * This check keeps no state and registers no listeners.
 */
export async function validateSamlXml(xml: string): Promise<string> {
  // SAML messages must not carry a DTD; rejecting it up front also rules out entity expansion.
  if (/<!(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error('SAML message must not contain a DTD.');
  // xmldom only reports some well-formedness problems (e.g. unclosed or mismatched tags) as warnings.
  const root = new DOMParser({ errorHandler: { warning: rejectXml, error: rejectXml, fatalError: rejectXml } })
    .parseFromString(xml, 'text/xml')
    .documentElement;
  if (!root || root.namespaceURI !== SAML_PROTOCOL_NS || root.localName !== 'AuthnRequest') {
    throw new Error('SAML message must be a SAML 2.0 protocol AuthnRequest.');
  }
  return 'SUCCESS_VALIDATE_XML';
}

function rejectXml(message: unknown): never {
  throw new Error(`Invalid SAML XML: ${String(message)}`);
}
