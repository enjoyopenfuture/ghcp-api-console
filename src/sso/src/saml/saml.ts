import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import * as samlify from 'samlify';
import { config } from '../config.js';
import type { SsoUserRecord } from '../db/usersRepo.js';
import { validateSamlXml } from './xmlValidator.js';

const require = createRequire(import.meta.url);
const { SamlLib } = require('samlify') as Pick<typeof import('samlify'), 'SamlLib'>;
samlify.setSchemaValidator({ validate: validateSamlXml });

const BINDING = {
  redirect: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  post: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
} as const;

const NAMEID_FORMAT_PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const ATTR_FMT_BASIC = 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic';
const XS = 'http://www.w3.org/2001/XMLSchema';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

const idpEntityId = `${config.baseUrl}/metadata`;
const idpSsoUrl = `${config.baseUrl}/sso`;
const idpLogoutUrl = `${config.baseUrl}/logout`;
const spEntityId = config.spEntityId || `https://github.com/enterprises/${config.enterpriseSlug}`;
const spAcsUrl = config.spAcsUrl || `${config.mockGithubBaseUrl}/enterprises/${config.enterpriseSlug}/saml/consume`;

const loginResponseTemplate =
  '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{ID}" Version="2.0" IssueInstant="{IssueInstant}" Destination="{Destination}" InResponseTo="{InResponseTo}">' +
  '<saml:Issuer>{Issuer}</saml:Issuer>' +
  '<samlp:Status><samlp:StatusCode Value="{StatusCode}"/></samlp:Status>' +
  `<saml:Assertion xmlns:xsi="${XSI}" xmlns:xs="${XS}" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{AssertionID}" Version="2.0" IssueInstant="{IssueInstant}">` +
  '<saml:Issuer>{Issuer}</saml:Issuer>' +
  '<saml:Subject><saml:NameID Format="{NameIDFormat}">{NameID}</saml:NameID>' +
  '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">' +
  '<saml:SubjectConfirmationData NotOnOrAfter="{SubjectConfirmationDataNotOnOrAfter}" Recipient="{SubjectRecipient}" InResponseTo="{InResponseTo}"/>' +
  '</saml:SubjectConfirmation></saml:Subject>' +
  '<saml:Conditions NotBefore="{ConditionsNotBefore}" NotOnOrAfter="{ConditionsNotOnOrAfter}">' +
  '<saml:AudienceRestriction><saml:Audience>{Audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>' +
  '<saml:AuthnStatement AuthnInstant="{AuthnInstant}" SessionIndex="{SessionIndex}">' +
  '<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>' +
  '</saml:AuthnStatement>' +
  '<saml:AttributeStatement>' +
  `<saml:Attribute Name="username" NameFormat="${ATTR_FMT_BASIC}"><saml:AttributeValue xmlns:xs="${XS}" xmlns:xsi="${XSI}" xsi:type="xs:string">{attrUsername}</saml:AttributeValue></saml:Attribute>` +
  `<saml:Attribute Name="full_name" NameFormat="${ATTR_FMT_BASIC}"><saml:AttributeValue xmlns:xs="${XS}" xmlns:xsi="${XSI}" xsi:type="xs:string">{attrFullname}</saml:AttributeValue></saml:Attribute>` +
  `<saml:Attribute Name="emails" NameFormat="${ATTR_FMT_BASIC}"><saml:AttributeValue xmlns:xs="${XS}" xmlns:xsi="${XSI}" xsi:type="xs:string">{attrEmail}</saml:AttributeValue></saml:Attribute>` +
  '</saml:AttributeStatement>' +
  '</saml:Assertion></samlp:Response>';

export interface ParsedAuthnRequest {
  id?: string;
  relayState?: string;
  forceAuthn?: boolean;
}

export interface SamlPostResponse {
  acsUrl: string;
  samlResponse: string;
  relayState: string;
}

const idp = samlify.IdentityProvider({
  entityID: idpEntityId,
  signingCert: readCert('idp-cert.pem'),
  privateKey: readCert('idp-key.pem'),
  nameIDFormat: [NAMEID_FORMAT_PERSISTENT],
  singleSignOnService: [
    { Binding: BINDING.redirect, Location: idpSsoUrl },
    { Binding: BINDING.post, Location: idpSsoUrl },
  ],
  singleLogoutService: [{ Binding: BINDING.post, Location: idpLogoutUrl }],
  wantAuthnRequestsSigned: false,
  loginResponseTemplate: { context: loginResponseTemplate, attributes: [] },
});

const sp = samlify.ServiceProvider({
  entityID: spEntityId,
  assertionConsumerService: [{ Binding: BINDING.post, Location: spAcsUrl }],
  nameIDFormat: [NAMEID_FORMAT_PERSISTENT],
  wantAssertionsSigned: true,
  authnRequestsSigned: false,
});

export function metadataXml(): string {
  return idp.getMetadata();
}

export async function parseAuthnRequest(query: Record<string, unknown>): Promise<ParsedAuthnRequest> {
  const result = await idp.parseLoginRequest(sp, 'redirect', { query });
  const extract = (result as { extract?: { request?: { id?: string; forceAuthn?: boolean; ForceAuthn?: boolean } } }).extract ?? {};
  return {
    id: extract.request?.id,
    relayState: typeof query.RelayState === 'string' ? query.RelayState : undefined,
    forceAuthn: extract.request?.forceAuthn ?? extract.request?.ForceAuthn ?? parseForceAuthn(query),
  };
}

export async function buildSamlResponse(user: SsoUserRecord, inResponseTo?: string, relayState?: string): Promise<SamlPostResponse> {
  const requestInfo = inResponseTo ? { extract: { request: { id: inResponseTo } } } : { extract: {} };
  const result = await idp.createLoginResponse(sp, requestInfo as never, 'post', { email: user.ssoUser }, (template: string) => {
    const responseId = `_${randomUUID()}`;
    const assertionId = `_${randomUUID()}`;
    const now = new Date();
    const notOnOrAfter = new Date(now.getTime() + 5 * 60 * 1000);
    const values: Record<string, string | undefined> = {
      ID: responseId,
      AssertionID: assertionId,
      Issuer: idpEntityId,
      Audience: spEntityId,
      Destination: spAcsUrl,
      SubjectRecipient: spAcsUrl,
      StatusCode: STATUS_SUCCESS,
      NameIDFormat: NAMEID_FORMAT_PERSISTENT,
      NameID: user.ssoUser,
      IssueInstant: now.toISOString(),
      ConditionsNotBefore: now.toISOString(),
      ConditionsNotOnOrAfter: notOnOrAfter.toISOString(),
      SubjectConfirmationDataNotOnOrAfter: notOnOrAfter.toISOString(),
      AuthnInstant: now.toISOString(),
      SessionIndex: responseId,
      InResponseTo: inResponseTo,
      attrUsername: user.ssoUser,
      attrFullname: user.ssoUser,
      attrEmail: user.email,
    };
    return { id: responseId, context: SamlLib.replaceTagsByValue(template, values) };
  });
  const post = result as unknown as { context: string; entityEndpoint?: string };
  return { acsUrl: post.entityEndpoint ?? spAcsUrl, samlResponse: post.context, relayState: relayState ?? '' };
}

function parseForceAuthn(query: Record<string, unknown>): boolean | undefined {
  if (typeof query.SAMLRequest !== 'string') return undefined;
  const xml = inflateRawSync(Buffer.from(query.SAMLRequest, 'base64')).toString('utf8');
  const match = xml.match(/\sForceAuthn="([^"]+)"/);
  return match ? match[1]!.toLowerCase() === 'true' : undefined;
}

function readCert(name: string): string {
  return readFileSync(resolve(config.certDir, name), 'utf8');
}
