// Trust provisioning for the test-signed identity package.
//
// The only thing this module may ever trust is the exact certificate that
// signed the exact package we built. Everything is checked before a byte is
// imported: the certificate's subject, purpose, validity and thumbprint, the
// package's real signer, and the manifest publisher. A certificate that merely
// travels next to an MSIX is not evidence of anything.
//
// Scope is deliberately narrow: LocalMachine\TrustedPeople, which is the store
// Windows uses for "this signer is trusted for this machine" on the MSIX path.
// It never writes to Root, never disables signature validation, never enables
// Developer Mode, and never exports a private key.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { artifactPaths, IDENTITY_NAME, PACKAGE_PUBLISHER, readJson } from './installer.mjs';

export const TRUST_STORE = 'Cert:\\LocalMachine\\TrustedPeople';
export const CODE_SIGNING_EKU = '1.3.6.1.5.5.7.3.3';

function sameThumbprint(left, right) {
  return String(left).replace(/\s/g, '').toUpperCase() === String(right).replace(/\s/g, '').toUpperCase();
}

/**
 * The policy, as a pure function. Every rule here is one the specification or
 * Victor's authorization names explicitly; nothing is inferred from proximity.
 */
export function assessCertificateTrust(facts, options = {}) {
  const problems = [];
  const now = options.now ?? new Date();
  const certificate = facts.certificate;

  if (!certificate) {
    return {
      ok: false,
      problems: [{ code: 'certificate-missing', detail: 'No readable certificate was provided.' }],
      certificateSha256: null,
    };
  }

  if (certificate.subject.trim().toLowerCase() !== PACKAGE_PUBLISHER.toLowerCase()) {
    problems.push({
      code: 'subject-mismatch',
      detail: `Certificate subject "${certificate.subject}" is not the build publisher "${PACKAGE_PUBLISHER}".`,
    });
  }
  if (certificate.hasPrivateKey) {
    problems.push({
      code: 'private-key-present',
      detail: 'The file to trust carries a private key. Only the public .cer may be imported.',
    });
  }
  if (!certificate.eku.includes(CODE_SIGNING_EKU)) {
    problems.push({
      code: 'not-code-signing',
      detail: `Certificate EKU does not include code signing (${CODE_SIGNING_EKU}); got ${
        certificate.eku.join(', ') || 'none'
      }.`,
    });
  }
  const notBefore = new Date(certificate.notBefore);
  const notAfter = new Date(certificate.notAfter);
  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) {
    problems.push({ code: 'validity-unreadable', detail: 'Certificate validity dates could not be read.' });
  } else {
    if (now < notBefore)
      problems.push({ code: 'not-yet-valid', detail: `Certificate is not valid before ${certificate.notBefore}.` });
    if (now > notAfter) problems.push({ code: 'expired', detail: `Certificate expired at ${certificate.notAfter}.` });
  }

  if (!facts.signingRecord) {
    problems.push({
      code: 'no-build-record',
      detail: 'No build signing record exists, so there is nothing to compare the certificate against.',
    });
  } else {
    if (!sameThumbprint(facts.signingRecord.thumbprint, certificate.thumbprint)) {
      problems.push({
        code: 'not-the-recorded-certificate',
        detail: `Certificate ${certificate.thumbprint} is not the one this build recorded (${facts.signingRecord.thumbprint}).`,
      });
    }
    if (facts.signingRecord.subject.trim().toLowerCase() !== certificate.subject.trim().toLowerCase()) {
      problems.push({ code: 'record-subject-mismatch', detail: 'The recorded certificate subject differs.' });
    }
  }

  if (!facts.signer) {
    problems.push({
      code: 'unsigned-package',
      detail: 'The package has no readable signature, so it cannot establish which certificate to trust.',
    });
  } else {
    if (!sameThumbprint(facts.signer.thumbprint, certificate.thumbprint)) {
      problems.push({
        code: 'signer-mismatch',
        detail: `The package was signed by ${facts.signer.thumbprint}, not by ${certificate.thumbprint}.`,
      });
    }
    if (facts.signer.subject.trim().toLowerCase() !== certificate.subject.trim().toLowerCase()) {
      problems.push({
        code: 'signer-subject-mismatch',
        detail: 'The package signer subject differs from the certificate.',
      });
    }
  }

  if (!facts.manifest) {
    problems.push({ code: 'manifest-unreadable', detail: 'The package manifest could not be read.' });
  } else {
    if (facts.manifest.publisher !== PACKAGE_PUBLISHER) {
      problems.push({
        code: 'publisher-mismatch',
        detail: `Manifest Publisher "${facts.manifest.publisher}" must equal the signing subject "${PACKAGE_PUBLISHER}" exactly.`,
      });
    }
    if (facts.manifest.name !== IDENTITY_NAME) {
      problems.push({
        code: 'identity-mismatch',
        detail: `Manifest Name "${facts.manifest.name}" is not "${IDENTITY_NAME}".`,
      });
    }
  }

  return { ok: problems.length === 0, problems, certificateSha256: certificate.sha256 };
}

function powershell(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

function lastJson(text) {
  try {
    return JSON.parse(text.split(/\r?\n/).filter(Boolean).at(-1) ?? '{}');
  } catch {
    return null;
  }
}

function quote(value) {
  return String(value).replaceAll("'", "''");
}

/** Reads a real file's certificate, signer and manifest without trusting any of it. */
export function collectTrustFacts(layout) {
  const artifacts = artifactPaths(layout);
  const certificatePath = artifacts.certificate;
  const msixPath = artifacts.msix;
  const facts = { certificate: null, signer: null, manifest: null, signingRecord: null };

  if (existsSync(artifacts.signing)) {
    try {
      const record = readJson(artifacts.signing);
      if (record?.thumbprint && record?.subject) {
        facts.signingRecord = {
          thumbprint: String(record.thumbprint),
          subject: String(record.subject),
          notAfter: String(record.notAfter ?? ''),
        };
      }
    } catch {
      facts.signingRecord = null;
    }
  }

  if (existsSync(certificatePath)) {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 '${quote(certificatePath)}'`,
      "$eku = @($c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.Format($false) })",
      "@{ subject = $c.Subject; thumbprint = $c.Thumbprint; notBefore = $c.NotBefore.ToUniversalTime().ToString('o'); notAfter = $c.NotAfter.ToUniversalTime().ToString('o'); hasPrivateKey = $c.HasPrivateKey; eku = $eku } | ConvertTo-Json -Compress",
    ].join('; ');
    const certResult = powershell(script);
    const parsed = certResult.ok ? lastJson(certResult.stdout) : null;
    if (parsed?.thumbprint) {
      const ekuText = Array.isArray(parsed.eku) ? parsed.eku.join(' ') : String(parsed.eku ?? '');
      const eku = [];
      if (ekuText.includes(CODE_SIGNING_EKU)) eku.push(CODE_SIGNING_EKU);
      facts.certificate = {
        subject: String(parsed.subject ?? ''),
        thumbprint: String(parsed.thumbprint ?? ''),
        notBefore: String(parsed.notBefore ?? ''),
        notAfter: String(parsed.notAfter ?? ''),
        hasPrivateKey: parsed.hasPrivateKey === true,
        eku,
        sha256: createHash('sha256').update(readFileSync(certificatePath)).digest('hex'),
      };
    }
  }

  if (existsSync(msixPath)) {
    const signerScript = [
      "$ErrorActionPreference='Stop'",
      `$s = Get-AuthenticodeSignature -FilePath '${quote(msixPath)}'`,
      'if (-not $s.SignerCertificate) { "{}" } else { @{ subject = $s.SignerCertificate.Subject; thumbprint = $s.SignerCertificate.Thumbprint; notAfter = $s.SignerCertificate.NotAfter.ToUniversalTime().ToString("o"); status = "$($s.Status)" } | ConvertTo-Json -Compress }',
    ].join('; ');
    const signerResult = powershell(signerScript);
    const signerParsed = signerResult.ok ? lastJson(signerResult.stdout) : null;
    if (signerParsed?.thumbprint) {
      facts.signer = {
        subject: String(signerParsed.subject),
        thumbprint: String(signerParsed.thumbprint),
        notAfter: String(signerParsed.notAfter),
      };
    }

    // Read the identity from the package itself, not from a staged text file.
    const manifestScript = [
      '$ErrorActionPreference="Stop"',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$zip = [System.IO.Compression.ZipFile]::OpenRead('${quote(msixPath)}')`,
      'try { $entry = $zip.Entries | Where-Object { $_.FullName -eq "AppxManifest.xml" }; if (-not $entry) { "{}" } else { $reader = New-Object System.IO.StreamReader($entry.Open()); $xml = [xml]$reader.ReadToEnd(); $reader.Close(); @{ name = $xml.Package.Identity.Name; publisher = $xml.Package.Identity.Publisher; version = $xml.Package.Identity.Version; architecture = $xml.Package.Identity.ProcessorArchitecture } | ConvertTo-Json -Compress } } finally { $zip.Dispose() }',
    ].join('; ');
    const manifestResult = powershell(manifestScript);
    const manifestParsed = manifestResult.ok ? lastJson(manifestResult.stdout) : null;
    if (manifestParsed?.publisher) {
      facts.manifest = {
        name: String(manifestParsed.name ?? ''),
        publisher: String(manifestParsed.publisher ?? ''),
        version: String(manifestParsed.version ?? ''),
        architecture: String(manifestParsed.architecture ?? ''),
      };
    }
  }

  return facts;
}

/** True when the current process can write LocalMachine certificate stores. */
export function isElevated() {
  const result = powershell(
    '$id = [Security.Principal.WindowsIdentity]::GetCurrent(); $p = New-Object Security.Principal.WindowsPrincipal($id); if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { "elevated" } else { "standard" }',
  );
  return result.ok && result.stdout.includes('elevated');
}

const PRESENCE_STORES = [
  'LocalMachine\\TrustedPeople',
  'LocalMachine\\Root',
  'CurrentUser\\TrustedPeople',
  'CurrentUser\\Root',
];

/** Where this certificate already exists, by exact thumbprint and store. */
export function trustPresence(thumbprint) {
  const script = PRESENCE_STORES.map(
    (store) =>
      `"${store}=" + $(if (Get-ChildItem -Path 'Cert:\\${store}' -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq '${thumbprint}' }) { 'present' } else { 'absent' })`,
  ).join('; ');
  const result = powershell(script);
  const out = {};
  for (const store of PRESENCE_STORES) out[store] = false;
  if (result.ok) {
    for (const line of result.stdout.split(/\r?\n/)) {
      const [store, state] = line.split('=');
      if (store && state) out[store.trim()] = state.trim() === 'present';
    }
  }
  return out;
}

/** The exact elevated command a person should run, with the real paths. */
export function elevationCommand(layout) {
  const artifacts = artifactPaths(layout);
  const repo = path.resolve(layout.repoRoot ?? '.');
  return [
    '# Run in an ELEVATED PowerShell (Run as administrator), then re-run the verifier:',
    `Import-Certificate -FilePath '${artifacts.certificate}' -CertStoreLocation '${TRUST_STORE}'`,
    `node '${repo}\\tools\\install\\cli.mjs' trust-test-certificate`,
  ].join('\n');
}

/**
 * Import the public certificate into LocalMachine\TrustedPeople, and nowhere
 * else. Idempotent: an already-present certificate is reported, not duplicated.
 * Refused when the process is not elevated, because a silent non-elevated
 * attempt would just produce a confusing duplicate of the machine policy gate.
 */
export function provisionTrust(layout, options = {}) {
  const artifacts = artifactPaths(layout);
  const facts = collectTrustFacts(layout);
  const verdict = assessCertificateTrust(facts, options);
  if (!verdict.ok) {
    return { ok: false, stage: 'verification', problems: verdict.problems, facts };
  }
  if (!isElevated()) {
    return {
      ok: false,
      stage: 'elevation',
      elevationRequired: true,
      certificate: artifacts.certificate,
      thumbprint: facts.certificate.thumbprint,
      store: TRUST_STORE,
      // Facts are reported even when the write is deferred, so the verification
      // itself can be audited without elevation.
      verified: {
        certificate: facts.certificate,
        signer: facts.signer,
        manifest: facts.manifest,
        signingRecord: facts.signingRecord,
        verdict,
      },
      presence: trustPresence(facts.certificate.thumbprint),
      problems: [
        {
          code: 'elevation-required',
          detail:
            'Writing LocalMachine\\TrustedPeople needs an elevated shell. Run the prepared command in an elevated terminal, then re-run this check.',
        },
      ],
    };
  }
  const thumbprint = facts.certificate.thumbprint;
  const before = trustPresence(thumbprint);
  if (before['LocalMachine\\TrustedPeople']) {
    return {
      ok: true,
      stage: 'trust',
      added: false,
      alreadyPresent: true,
      thumbprint,
      store: TRUST_STORE,
      presence: before,
      certificate: artifacts.certificate,
    };
  }
  const result = powershell(
    `Import-Certificate -FilePath '${quote(artifacts.certificate)}' -CertStoreLocation '${TRUST_STORE}' -ErrorAction Stop | Out-Null; "imported"`,
  );
  const after = trustPresence(thumbprint);
  const added = result.ok && after['LocalMachine\\TrustedPeople'] === true;
  return {
    ok: added,
    stage: 'trust',
    added,
    alreadyPresent: false,
    thumbprint,
    store: TRUST_STORE,
    presence: after,
    certificate: artifacts.certificate,
    error: added ? null : result.stderr || result.stdout || 'import failed',
  };
}

/** Remove exactly this certificate from TrustedPeople. Refuses to touch Root. */
export function removeTrust(layout) {
  const artifacts = artifactPaths(layout);
  const facts = collectTrustFacts(layout);
  const thumbprint = facts.certificate?.thumbprint ?? null;
  if (!thumbprint) return { ok: false, error: 'No certificate thumbprint is readable, so nothing was removed.' };
  if (!isElevated()) {
    return {
      ok: false,
      stage: 'elevation',
      elevationRequired: true,
      thumbprint,
      store: TRUST_STORE,
      error: 'Removing a LocalMachine certificate needs an elevated shell.',
    };
  }
  const before = trustPresence(thumbprint);
  if (!before['LocalMachine\\TrustedPeople']) {
    return { ok: true, removed: false, alreadyAbsent: true, thumbprint, store: TRUST_STORE, presence: before };
  }
  const result = powershell(
    `$path = Join-Path 'Cert:\\LocalMachine\\TrustedPeople' '${thumbprint}'; Remove-Item -Path $path -Force -ErrorAction Stop; "removed"`,
  );
  const after = trustPresence(thumbprint);
  const removed = result.ok && after['LocalMachine\\TrustedPeople'] === false;
  return {
    ok: removed,
    removed,
    thumbprint,
    store: TRUST_STORE,
    presence: after,
    rootUntouched: after['LocalMachine\\Root'] === false && after['CurrentUser\\Root'] === false,
    error: removed ? null : result.stderr || result.stdout || 'removal failed',
  };
}
