// Trust policy: the rules that decide whether this machine may trust a
// certificate. These tests never touch a certificate store; they pin the
// decision so a later edit cannot quietly widen what is trusted.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CODE_SIGNING_EKU, TRUST_STORE, assessCertificateTrust } from '../../tools/install/trust.mjs';

const THUMB = '5C0AD0D7281A1B994DF4BB13B8B354E69BB74C95';
const OTHER_THUMB = 'A'.repeat(40);

const facts = () => ({
  certificate: {
    subject: 'CN=Mona Development',
    thumbprint: THUMB,
    notBefore: '2026-11-12T00:00:00.000Z',
    notAfter: '2027-11-12T00:00:00.000Z',
    hasPrivateKey: false,
    eku: [CODE_SIGNING_EKU],
    sha256: 'b'.repeat(64),
  },
  signer: { subject: 'CN=Mona Development', thumbprint: THUMB, notAfter: '2027-11-12T00:00:00.000Z' },
  manifest: { name: 'MonaWorkbench', publisher: 'CN=Mona Development', version: '0.1.0.0', architecture: 'x64' },
  signingRecord: { thumbprint: THUMB, subject: 'CN=Mona Development', notAfter: '2027-11-12T00:00:00.000Z' },
});

const now = { now: new Date('2026-11-12T18:00:00.000Z') };

function codes(result) {
  return result.problems.map((problem) => problem.code).sort();
}

describe('certificate trust policy', () => {
  it('trusts only the store that the MSIX path uses, not Root', () => {
    assert.equal(TRUST_STORE, 'Cert:\\LocalMachine\\TrustedPeople');
    assert.equal(/Root/.test(TRUST_STORE), false);
  });

  it('accepts the exact certificate, signer, record and publisher of this build', () => {
    const verdict = assessCertificateTrust(facts(), now);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.certificateSha256, 'b'.repeat(64));
  });

  it('refuses a file that was never the build certificate', () => {
    const f = facts();
    f.certificate.thumbprint = OTHER_THUMB;
    const verdict = assessCertificateTrust(f, now);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict).includes('not-the-recorded-certificate'));
    assert.ok(codes(verdict).includes('signer-mismatch'));
  });

  it('refuses a different subject even when the thumbprint matches the record', () => {
    const f = facts();
    f.certificate.subject = 'CN=Someone Else';
    f.signingRecord.subject = 'CN=Someone Else';
    const verdict = assessCertificateTrust(f, now);
    assert.ok(codes(verdict).includes('subject-mismatch'));
    assert.ok(codes(verdict).includes('signer-subject-mismatch'));
  });

  it('refuses a certificate that carries a private key', () => {
    const f = facts();
    f.certificate.hasPrivateKey = true;
    assert.ok(codes(assessCertificateTrust(f, now)).includes('private-key-present'));
  });

  it('refuses a certificate without the code-signing purpose', () => {
    const f = facts();
    f.certificate.eku = ['1.3.6.1.5.5.7.3.2'];
    assert.ok(codes(assessCertificateTrust(f, now)).includes('not-code-signing'));
  });

  it('refuses an expired or not-yet-valid certificate', () => {
    const expired = assessCertificateTrust(facts(), { now: new Date('2027-11-13T00:00:00.000Z') });
    assert.ok(codes(expired).includes('expired'));
    const early = assessCertificateTrust(facts(), { now: new Date('2026-11-11T00:00:00.000Z') });
    assert.ok(codes(early).includes('not-yet-valid'));
  });

  it('refuses a package with no signature or a missing build record', () => {
    const unsigned = facts();
    unsigned.signer = null;
    assert.ok(codes(assessCertificateTrust(unsigned, now)).includes('unsigned-package'));
    const noRecord = facts();
    noRecord.signingRecord = null;
    assert.ok(codes(assessCertificateTrust(noRecord, now)).includes('no-build-record'));
  });

  it('requires the manifest publisher to match the signing subject exactly', () => {
    const f = facts();
    f.manifest.publisher = 'CN=Mona Development ';
    assert.ok(codes(assessCertificateTrust(f, now)).includes('publisher-mismatch'));
    const wrong = facts();
    wrong.manifest.publisher = 'CN=Mona';
    assert.ok(codes(assessCertificateTrust(wrong, now)).includes('publisher-mismatch'));
  });

  it('refuses a package for a different app identity', () => {
    const f = facts();
    f.manifest.name = 'SomethingElse';
    assert.ok(codes(assessCertificateTrust(f, now)).includes('identity-mismatch'));
  });

  it('reports a missing certificate rather than trusting nothing silently', () => {
    const verdict = assessCertificateTrust({ certificate: null, signer: null, manifest: null, signingRecord: null });
    assert.equal(verdict.ok, false);
    assert.deepEqual(codes(verdict), ['certificate-missing']);
  });
});
