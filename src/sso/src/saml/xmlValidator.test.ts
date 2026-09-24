import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSamlXml } from './xmlValidator.js';

const PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
const authnRequest = (prefix: string) => {
  const tag = prefix ? `${prefix}:AuthnRequest` : 'AuthnRequest';
  const ns = prefix ? `xmlns:${prefix}="${PROTOCOL}"` : `xmlns="${PROTOCOL}"`;
  return `<${tag} ${ns} xmlns:saml="${ASSERTION}" ID="_req" Version="2.0" IssueInstant="2026-01-01T00:00:00Z"><saml:Issuer>https://github.com/enterprises/acme</saml:Issuer></${tag}>`;
};

test('accepts SAML 2.0 AuthnRequests regardless of namespace prefix', async () => {
  for (const prefix of ['samlp', 'saml2p', '']) {
    assert.equal(await validateSamlXml(authnRequest(prefix)), 'SUCCESS_VALIDATE_XML', `prefix "${prefix}"`);
  }
});

test('rejects malformed XML, DTDs and messages other than a protocol AuthnRequest', async () => {
  const rejected = {
    empty: '',
    text: 'not xml',
    unclosed: `<samlp:AuthnRequest xmlns:samlp="${PROTOCOL}" ID="_req">`,
    mismatched: `<samlp:AuthnRequest xmlns:samlp="${PROTOCOL}" ID="_req"></samlp:Response>`,
    unquotedAttribute: `<samlp:AuthnRequest xmlns:samlp="${PROTOCOL}" ID=_req/>`,
    twoRoots: `${authnRequest('samlp')}<foo/>`,
    undefinedEntity: `<samlp:AuthnRequest xmlns:samlp="${PROTOCOL}" ID="_req">&foo;</samlp:AuthnRequest>`,
    doctype: `<!DOCTYPE r [<!ENTITY x "y">]>${authnRequest('samlp')}`,
    entity: `<!ENTITY x SYSTEM "file:///etc/passwd">${authnRequest('samlp')}`,
    logoutRequest: `<samlp:LogoutRequest xmlns:samlp="${PROTOCOL}" ID="_lo" Version="2.0" IssueInstant="2026-01-01T00:00:00Z"/>`,
    response: `<samlp:Response xmlns:samlp="${PROTOCOL}" ID="_r" Version="2.0" IssueInstant="2026-01-01T00:00:00Z"/>`,
    nonSaml: '<foo ID="_x"/>',
    wrongNamespace: '<samlp:AuthnRequest xmlns:samlp="urn:example:not-saml" ID="_req"/>',
    noNamespace: '<AuthnRequest ID="_req"/>',
  };
  for (const [name, xml] of Object.entries(rejected)) {
    await assert.rejects(validateSamlXml(xml), Error, name);
  }
});

test('repeated validation registers no process-level listeners', async () => {
  const uncaught = process.listenerCount('uncaughtException');
  const drain = process.stdout.listenerCount('drain');
  for (let i = 0; i < 200; i += 1) {
    await validateSamlXml(authnRequest('samlp'));
    await validateSamlXml('<foo/>').catch(() => undefined);
  }
  assert.equal(process.listenerCount('uncaughtException'), uncaught);
  assert.equal(process.stdout.listenerCount('drain'), drain);
});
