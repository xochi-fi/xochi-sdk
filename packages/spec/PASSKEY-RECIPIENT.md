# Passkey recipients

- **Status:** PROPOSED. Decided in epic xochi-fi/xochi#833 (xochi-fi/xochi-sdk#155) on 2026-11-08.
  It replaces the sealed backup file of xochi-fi/xochi#759 for passkey recipients, and needs
  product-owner sign-off before any deployment accepts it.
- **Version:** derivation version 1, backup format `xochi.shielded.backup-format.passkey.v1`.
- **Vectors:** `conformance/shielded-recipient.json`, section `passkey`. They are held to the real
  `@aztec-labs` 6.0.0 SDK by `aztec-crosscheck/`.
- **Reference implementation:** `@xochi/signer` (`passkey-recipient.ts`, plus `passkeyBackupCommitment`
  and the backup format rules in `shielded-recipient-acks.ts`).

A Stealth on Aztec (OXDAI) recipient who claims at `xochi.fi/claim` holds no passphrase and no backup
file. One WebAuthn passkey, bound to the relying party `xochi.fi` and evaluated with the PRF
extension, derives the recipient's Aztec account. A recipient created earlier with the
`xochi-recipient` CLI can be imported and kept wrapped under the same passkey. The
`BackupPersistenceAck` the recipient signs at enrollment then names the passkey instead of a sealed
file.

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## 1. Derivation (version 1)

### 1.1 Constants

| Name | Value |
|---|---|
| RP ID (`PASSKEY_RP_ID`) | `"xochi.fi"`. Production code has no override. Tests MAY use `localhost` through an explicit test-only option. |
| RP name | `"Xochi"` |
| Derivation version (`PASSKEY_DERIVATION_V1`) | `1` |
| PRF eval input `first` (account purpose) | `SHA-256(UTF8("xochi.recipient.passkey.v1/prf/account"))` = `0xda78e1a895e2650478d184cb97b68a58a700ebbc2fd12d57a394873c93439dea` |
| PRF eval input `second` (wrap purpose) | `SHA-256(UTF8("xochi.recipient.passkey.v1/prf/wrap"))` = `0x76b121dc2850fb29af74dcd8357c9c9fd4992d2990cdcd3144c704220b83fda4` |
| HKDF | HKDF-SHA-256 (RFC 5869) |
| HKDF salt, every output | `UTF8("xochi.recipient.passkey.v1")` |
| HKDF info, account secret | `UTF8("xochi.recipient.passkey.v1/account-secret")`, L = 64 |
| HKDF info, account salt | `UTF8("xochi.recipient.passkey.v1/account-salt")`, L = 64 |
| HKDF info, wrap key | `UTF8("xochi.recipient.passkey.v1/wrap-key")`, L = 32 |
| r | the BN254 scalar field order, `21888242871839275222246405745257275088548364400416034343698204186575808495617` (`AZTEC_FIELD_MODULUS`) |

The two eval inputs are what the page passes as `extensions.prf.eval.{first, second}`, and both are
evaluated in one ceremony. Before the authenticator sees an input, the browser hashes it again as
`SHA-256("WebAuthn PRF" || 0x00 || input)` (WebAuthn Level 3 §10.1.4). The page never computes that
second hash.

### 1.2 Outputs

```
prf.first, prf.second = getClientExtensionResults().prf.results.{first, second}   // each exactly 32 bytes
accountSecret = OS2IP(HKDF(prf.first,  salt, info = account-secret, 64)) mod r       // refuse if 0
accountSalt   = OS2IP(HKDF(prf.first,  salt, info = account-salt,   64)) mod r       // refuse if 0
wrapKey       = HKDF(prf.second, salt, info = wrap-key, 32)                          // AES-256-GCM key
AccountSecrets = { secret: hex32(accountSecret), salt: hex32(accountSalt) }          // 0x + 64 lowercase hex
```

The 64-byte outputs are reduced the wide way (64 bytes = 512 bits for a 254-bit field), so the bias
is negligible. `AccountSecrets` is exactly the recipient CLI's `AccountSecrets`. From it the CLI
builds a stock `SchnorrAccount` (`@aztec-labs/accounts` 6.0.0): signing key
`deriveMasterMessageSigningSecretKey(secret)`, public keys `deriveKeys(secret)`, salt `salt`,
deployer `AztecAddress.ZERO`. The class pin and `immutablesHash = 0` are unchanged, so the
descriptor, binding and every acknowledgement work exactly as for a CLI recipient. One passkey is one
recipient; there is no account index.

The caller imports `wrapKey` into WebCrypto as a non-extractable `AES-GCM` key
(`["encrypt", "decrypt"]`) and then zeroes the byte array. `@xochi/signer` zeroes its own
intermediate HKDF outputs and never puts a PRF or derived byte into an error message.

### 1.3 Derivation refusals

`derivePasskeyRecipientKeys(prf, version?)` throws `PasskeyDerivationError`:

| `code` | `field` | When |
|---|---|---|
| `unsupported_version` | `version` | `version` is anything but `1`. |
| `prf_output_invalid` | `prf`, `prf.first`, `prf.second` | An output is missing, or is not a `Uint8Array` of exactly 32 bytes. A missing output means the authenticator did not evaluate PRF; see §3. |
| `derived_zero` | `accountSecret`, `accountSalt` | The reduction is 0. No preimage is known, so there is no vector. |

### 1.4 Reference vectors

| name | prf.first | prf.second | secret | salt | wrapKey |
|---|---|---|---|---|---|
| `zeros-ones` | 32 x `0x00` | 32 x `0x01` | `0x16e61e8361407b35f5355c5a84878cf653f211f0747e0f5070623fcd4a6f7e82` | `0x09976444a011a99a61e1c10045618355e1a0170df7322cba11d1230c8c916679` | `0x88c5497da2bcbdd9ca0fd9959ced6779ce674025253b1f7d0ab99d123ba6f97b` |
| `sha256-labels` | `SHA-256("TEST ONLY prf first")` | `SHA-256("TEST ONLY prf second")` | `0x25a853a998db29033e2736b012009c2fc43020ed8bb69367683a7c2a8e7af0b6` | `0x17d0b81b79aa82aab662c3789626002c5b713e92cb2610a978271c73ddedede7` | `0x1154a7392a60a14f07d534d42df8d0231aff0842ef8b230615b02557ba6f2c94` |

The `passkey.derivations` entries also give the raw HKDF outputs and the full account: the descriptor,
its digest and every address-derivation intermediate under profile `aztec-6.0.0`. Addresses:
`zeros-ones` -> `0x0184719b1aac0714af7e0e82d9c5470fdd66ba90f52cfa7929217569b40c219f`,
`sha256-labels` -> `0x201b973312ba0dc57a4029a772f57a7ef5cfb46622ac9ea2572851b88f51bc24`. The
generator uses node's `hkdfSync`, `@xochi/signer` uses `@noble/hashes`, and `aztec-crosscheck` checks
the reduction (`Fr.fromBufferReduce`) and the account (`deriveKeys`,
`deriveMasterMessageSigningSecretKey`, `getContractInstanceFromInstantiationParams`) against the SDK.
`passkey.derivationRefusals` lists the refused inputs.

## 2. WebAuthn parameters

The ceremony runs locally in the claim page. Nothing is sent to a server, and the challenge is never
verified by one.

Create:

```ts
{ publicKey: {
  rp: { id: "xochi.fi", name: "Xochi" },
  user: { id: crypto.getRandomValues(new Uint8Array(32)), name: "Xochi recipient", displayName: "Xochi recipient" },
  challenge: crypto.getRandomValues(new Uint8Array(32)),
  pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
  authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
  attestation: "none", timeout: 120_000,
  extensions: { prf: { eval: { first, second } } },
} }
```

`user.id` is random and MUST NOT be the wallet address. After create:

- If `prf.enabled !== true`, refuse with `prf_unsupported`. The credential is useless, so tell the
  user to delete it.
- If create already returned `prf.results`, use them.
- Otherwise run one get. Results at create time depend on the authenticator, see §8.

Get:

```ts
{ publicKey: { rpId: "xochi.fi", challenge: random32, userVerification: "required", timeout: 120_000,
  allowCredentials: knownCredentialId ? [{ type: "public-key", id: knownCredentialId }] : [],
  extensions: { prf: { eval: { first, second } } } } }
```

An empty `allowCredentials` makes the request discoverable, which is how a new device finds a synced
passkey. The result is `{ credentialId: rawId, credentialIdHash: keccak256(rawId) (lowercase hex),
prf: { first, second } }`. PRF results MUST NOT leave the page: `PublicKeyCredential.toJSON()`
includes them, so never serialize a credential to a server.

## 3. Refusals and the PRF-unavailable path

Every ceremony failure is one error class, `PasskeyError`, with one of these `code`s:

| `code` | When | UI |
|---|---|---|
| `webauthn_unavailable` | No `PublicKeyCredential`, or not a secure context. | "This browser cannot create passkeys." |
| `prf_unsupported` | `getClientCapabilities()["extension:prf"] === false` (pre-check); `prf.enabled !== true` at create; `prf.results.first/second` missing or not 32 bytes at get. | "Your browser or passkey provider does not support the PRF extension." Then the supported list (below). |
| `passkey_cancelled` | `NotAllowedError` / `AbortError` | A retry button. |
| `passkey_failed` | Anything else. The message is kept and logged with `console.error`. | |

There is **no passphrase fallback for new passkey recipients**. If PRF is unavailable, the page
refuses, shows the supported list, and creates nothing. A user who cannot use a supported passkey
can still receive with the `xochi-recipient` CLI (sealed backup, xochi#759), and can later import
that recipient under a supported passkey (§4).

A capability report of `true` describes the browser, not the authenticator. Chrome and Firefox
hard-code `extension:prf: true`, and WebAuthn Level 3 §5.1.7 says relying parties MUST NOT infer
authenticator support from it. Only `extension:prf === false` short-circuits. The verdict is always
the actual `prf` output.

Suggested supported list for the UI. It is derived from §8, and the rows marked UNVERIFIED there
are its weakest claims:

> Passkey claims need a passkey provider that supports the WebAuthn PRF extension: Apple Passwords
> (iCloud Keychain) on iOS/iPadOS 18.4+ or macOS 15+ in Safari, Chrome or Firefox; Google Password
> Manager on Android or in desktop Chrome; 1Password; or Windows Hello on an up-to-date Windows 11 in
> current Chrome, Edge or Firefox. Bitwarden, Dashlane, NordPass, Windows 10 and in-app browsers do
> not work. Security keys work in Chrome, Edge or Firefox but are not synced (see "single copy").

## 4. Wrapped import (`PKW1`)

This brings a CLI-created recipient under the passkey.

```
PKW1 = MAGIC (16) || IV (12) || ciphertext || tag (16)
MAGIC = ASCII "XOCHI-RCPT-PKW1\n"
AES-256-GCM under wrapKey, AAD = MAGIC || credentialIdHash (32 raw bytes)
plaintext = UTF-8 JSON of the CLI BackupContents (tools/recipient/src/backup.ts BackupSchema)
```

The plaintext comes from the user's sealed backup file and passphrase (`sealed.ts` "backup" kind,
scrypt N = 2^17, r = 8, p = 1). Neither the passphrase nor the plaintext is ever stored. The import
is stored under `recipient/<credentialIdHash>/imported.pkw1`. Binding the AAD to `credentialIdHash`
means a wrapped import moved to another credential fails to decrypt.

The non-secret profile record is stored under `recipient/<credentialIdHash>/profile.json`:
`{ version: 1, mode: "passkey" | "imported", credentialId (base64url), credentialIdHash, rpId,
derivationVersion: 1, address, createdAt }`.

## 5. Backup acknowledgement: passkey mode

There is no new primary type and no new purpose. `BackupPersistenceAck` keeps its type, its typehash
`0xed3674ce…4539`, its purpose `xochi.shielded.backup-persistence-ack.v1` and its struct, and gains a
second accepted `backupFormatId`. **The format id is the mode.** Every sealed-file vector is
byte-identical.

| | Sealed file (unchanged) | Passkey (new) |
|---|---|---|
| `backupFormatId` | `BACKUP_FORMAT_V1_ID` = `keccak256(UTF8("xochi.shielded.backup-format.v1"))` | `BACKUP_FORMAT_PASSKEY_V1_ID` = `keccak256(UTF8("xochi.shielded.backup-format.passkey.v1"))` = `0xfc8e02b9741f099f45fc73cf480359a580e322ceae9ca66d3964a987ad4517f2` |
| `backupCommitment` | `keccak256(sealedBackupBytes)` | `keccak256(abi.encode(bytes32 PASSKEY_BACKUP_COMMITMENT_TAG, bytes32 credentialIdHash, bytes32 keccak256(UTF8(rpId)), uint32 derivationVersion))` |

`PASSKEY_BACKUP_COMMITMENT_TAG` = `keccak256(UTF8("xochi.shielded.passkey-backup-commitment.v1"))` =
`0x8f222f44e0f186187a38e34bdcf4086619e6536187560450d9a0ce200249f025`.

`passkeyBackupCommitment({ credentialIdHash, rpId, derivationVersion })` refuses with
`AckEncodingError`:

| `code` | `field` | When |
|---|---|---|
| `not_bytes32` | `credentialIdHash` | Not `0x` + 64 hex. Case does not change the commitment. |
| `digest_zero` | `credentialIdHash` | Zero. |
| `rp_id_mismatch` | `rpId` | Anything but exactly `"xochi.fi"` (case-sensitive, no subdomain). |
| `derivation_version_unsupported` | `derivationVersion` | Anything but the number `1`. |

Vector: `credentialIdHash = keccak256(UTF8("TEST ONLY credential id"))` =
`0x0f51d6f267f479d4f99be0115f01345c551b48f352902e002a2ff851b20f63f2`, `rpId` `xochi.fi`, version `1`,
gives commitment `0x1eb1bdb8239f3781e41bcc837832336ad05b52229f01c6074e8dcf6da92c4887`.

Encoding: `hashRecipientAck` accepts `backupFormatId` in {`BACKUP_FORMAT_V1_ID`,
`BACKUP_FORMAT_PASSKEY_V1_ID`}. Any other value refuses with `backup_format_mismatch`.

Verification: `verifyRecipientAck`'s `expected` for `BackupPersistenceAck` is
`{ backupCommitment, backupFormatId? }`.

- `backupFormatId` absent: the acknowledgement MUST name `BACKUP_FORMAT_V1_ID`, else
  `backup_format_mismatch`. A verifier that predates passkey mode therefore never accepts one.
- `backupFormatId` present: the acknowledgement MUST name exactly that id, else `subject_mismatch`.
- The commitment is compared as before (`subject_mismatch`).

The Worker (xochi#835) takes an optional `backup_passkey: { credential_id_hash, rp_id: "xochi.fi",
derivation_version: 1 }` on enrollment.

- Absent: sealed mode exactly as today.
- Present: the Worker computes `passkeyBackupCommitment(...)`, requires the acknowledgement's
  `backupCommitment` to equal it, and verifies with
  `{ backupCommitment: computed, backupFormatId: BACKUP_FORMAT_PASSKEY_V1_ID }`.

It stores the format id. It stores nothing about the credential beyond the commitment.

The vectors (`passkey.backup`) contain:

- the commitments and their refusals;
- the passkey recipient's own signed `RecipientBinding` and signed passkey-mode
  `BackupPersistenceAck` (real Grumpkin Schnorr signatures by the `sha256-labels` account, TEST
  ONLY);
- an unknown-format refusal;
- `verification`, the verifier's verdict for each combination of mode and expectation. `error: null`
  means accepted. The sealed-file rows use `acknowledgements.vectors`' `BackupPersistenceAck
  (binding X)`.

## 6. Threat model

- **A lost passkey means lost funds.** The passkey is the only key: the account secret exists only
  as a PRF output of that credential. Nobody can recover the funds if the passkey is lost and not
  synced to another device, Xochi included. The UI MUST say so before create and in the claim page
  footer: "Your passkey is the only key to these funds. If you lose it (and it is not synced to
  another device), the funds cannot be recovered by anyone, including Xochi."
- **Recovery is the synced passkey.** iCloud Keychain, Google Password Manager and 1Password sync the
  credential, and its PRF secret with it, so another signed-in device derives the same account.
  Deleting the passkey from the provider deletes the funds' key everywhere.
- **A non-synced authenticator is a single copy.** A hardware security key, or a device-bound platform
  credential, holds the only copy. Losing or resetting that authenticator loses the funds. The UI
  SHOULD warn when the credential is not backed up. The authenticator data's backup-eligible and
  backup-state flags (BE/BS) are the hint, not a guarantee.
- **The same credential can give different PRF output across clients.**
  - Safari 26.4 returns undecrypted `hmac-secret` output for security keys (WebKit bug 311099).
  - iOS 18.0-18.3 differed over hybrid (UNVERIFIED, §8).
  - A different output derives a different, empty account, not an error. The page MUST fail closed:
    it compares the derived address with the profile record's `address` (and, on a new device, with
    the address the Worker holds for the binding), refuses on mismatch, and never treats the
    mismatch as a new recipient. An imported recipient fails closed on its own (the AES-GCM tag).
- **Xochi stores only the commitment.** The Worker learns `credentialIdHash`, the RP ID and the
  version through the commitment, never the credential id, the PRF output or any key. The commitment
  is public data: it identifies a credential but unlocks nothing.
- **The acknowledgement is a statement, not a proof.** The Worker cannot verify that the passkey
  exists or is synced, just as it cannot verify that a sealed file exists. The acknowledgement is the
  recipient's statement, signed by the derived account.
- **The RP ID binds the passkey to `xochi.fi` and every subdomain of it.** A page on another site
  cannot evaluate this credential's PRF. But WebAuthn lets any origin whose host is `xochi.fi` or
  ends in `.xochi.fi` use RP ID `xochi.fi`, so every such origin can derive the recipient's keys
  with the user's consent to one passkey prompt. Every host under `xochi.fi` is therefore inside the
  key's trust boundary and MUST be served only by Xochi. A claim page on `claim.xochi.fi` (a
  follow-on) keeps RP ID `xochi.fi`. A different RP ID would be a different credential and a
  different account, so it is a new derivation version, never an override.
- **XSS on the claim page is key compromise.** Script running in the page can call the ceremony and
  read the PRF output. The claim page carries the epic's isolation headers (COOP/COEP) and SHOULD
  load no third-party script.

## 7. Versioning

Any change to a label, salt, info string, length, reduction, RP ID or account construction is a new
derivation version. It gets a new `derivationVersion` and new labels, and with them a new
commitment. Version 1 is never reinterpreted.

## 8. PRF support matrix (as of 2026-11-08)

"verified" means a primary source (W3C, browser source or release notes, vendor documentation) was
read and says so. "UNVERIFIED" means only secondary sources or indirect evidence; the row says what
was found. Create-time results matter for §2: without them the page runs one extra get.

### Browsers

| Browser | PRF | Since | Results at create | Status |
|---|---|---|---|---|
| Chrome / Edge desktop | yes | 116 | Depends on the authenticator: iCloud Keychain on macOS from 132; CTAP 2.2 security keys (`hmac-secret-mc`) from 146; Windows Hello from 147; hybrid yes | verified [1][2][3][4] |
| Chrome Android | yes | 116 | Google Password Manager: reportedly yes (secondary). USB security keys yes, NFC no (mid-2025) | verified for get [2][5][6]; create UNVERIFIED |
| Android WebView (in-app browsers) | **no** | n/a | n/a | verified [2] |
| Safari macOS | yes | 18.0 (macOS 15) for iCloud Keychain; 26.4 for security keys | Yes for iCloud Keychain. Security keys broken: output returned undecrypted (WebKit 311099); YubiKey Bio returns null (WebKit 314934) | verified [7][8][9][10][11] |
| Safari iOS / iPadOS (and every iOS browser, all WebKit) | yes | 18.0 | Yes for iCloud Keychain | verified [7][9][12]; security keys on iOS 26.4 UNVERIFIED |
| Firefox desktop | yes | 135 (Windows, Linux), 139 (all desktop including macOS) | Windows from 147; macOS/Linux UNVERIFIED | verified [13][14][15] |
| Firefox Android | yes | 149 | UNVERIFIED | verified [16] |

`getClientCapabilities()`: Chrome/Edge 133+ and Firefox 135+ report `extension:prf: true`
unconditionally [17][18]. Safari (17.4+) gets its answer from a private framework, so whether it
reports `extension:prf` is UNVERIFIED.

### Platform authenticators

| Provider | PRF | Since | Status |
|---|---|---|---|
| iCloud Keychain (Apple Passwords) | yes, results at create | iOS/iPadOS 18, macOS 15. Through Safari 18+, Chrome 132+ on macOS, Firefox 139+ | verified [3][9] |
| Google Password Manager, Android | yes | before Oct 2023 | verified for get [5]; create UNVERIFIED |
| Google Password Manager, desktop Chrome | yes | Chrome version unknown | verified for support [1]; version UNVERIFIED |
| Chrome profile authenticator (legacy, non-GPM) | **no** | n/a | verified [1][19] |
| Windows Hello, Windows 10 and Windows 11 before Feb 2026 | **no** | n/a | verified [1][6] |
| Windows Hello, Windows 11 24H2/25H2 with the Feb 2026 cumulative update (KB5077181) or later | reportedly yes, with Chrome/Edge 147+ and Firefox 147+ | Feb 2026 | **UNVERIFIED**: the API exists (`WEBAUTHN_API_VERSION_8`) [20], and a Chromium commit says "PRF on create seems to be working fine on Windows 11" [4]. The KB release notes do not mention PRF, and no Microsoft document says Windows Hello supports it. |
| Microsoft Password Manager (Edge) | create works, get fails | n/a | UNVERIFIED (secondary only) |
| Samsung Pass | get only | n/a | UNVERIFIED (secondary only) |

### Roaming authenticators and third-party providers

| Authenticator / provider | PRF | Notes | Status |
|---|---|---|---|
| YubiKey 5 (CTAP2 `hmac-secret`, firmware 5.2+) | yes, through browser PRF | Results at create need firmware 5.8+ (`hmac-secret-mc`) and Chrome/Edge 146+; older keys need a second touch (get). Not synced: single copy. Broken in Safari (WebKit 311099). On Windows, discoverable credentials only (satisfied by `residentKey: "required"`). | verified [6][21][22] |
| 1Password (browser extension 2.26.1+, Android 8.10.38+) | yes | Synced. Create-time results UNVERIFIED | verified for get [23] |
| Bitwarden (as a passkey provider for sites) | **no** | Feature request open since 2025-03 | verified (open request) [24] |
| Dashlane, NordPass | **no** | | UNVERIFIED (secondary only) |
| Proton Pass, Keeper, Enpass | yes per third-party tests | | UNVERIFIED (secondary only) |

### Cross-device (hybrid, phone as authenticator)

- Chrome/Edge desktop to a phone: PRF works over hybrid, including at create. Verified [1][4].
- iPhone as the hybrid authenticator: iOS 18.0-18.3 reportedly returned a different PRF output than
  locally, fixed in 18.4. UNVERIFIED: the Apple forum thread could not be read [25].
- Safari, Windows-mediated and Firefox hybrid flows: UNVERIFIED.

### Sources

Primary sources unless marked. They were collected by web research on 2026-11-08; the rows marked
verified were confirmed against them.

1. blink-dev, "Intent to Ship: WebAuthn PRF extension" (Adam Langley):
   https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI
2. MDN browser-compat-data, `api/CredentialsContainer.json`:
   https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/CredentialsContainer.json
   (its `get` PRF cells for Safari and Firefox Android are stale; its own `create` cells and the
   vendor sources below are authoritative)
3. Chromium issue 366445189 (iCloud Keychain PRF): https://issues.chromium.org/issues/366445189
4. Chromium issue 420689820 and commits https://chromium-review.googlesource.com/changes/7569106,
   https://chromium-review.googlesource.com/changes/7600513/revisions/current/commit
5. w3c/webauthn#1830 (Adam Langley on Google Password Manager):
   https://github.com/w3c/webauthn/issues/1830#issuecomment-1774092530
6. Yubico, Developers' guide to PRF:
   https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html
7. WebKit, "WebKit features in Safari 18.0": https://webkit.org/blog/15865/webkit-features-in-safari-18-0/
8. WebKit, "WebKit features for Safari 26.4": https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
9. Apple, `ASAuthorizationPublicKeyCredentialPRFRegistrationInput`:
   https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfregistrationinput-c.class
10. WebKit bug 311099: https://bugs.webkit.org/show_bug.cgi?id=311099
11. WebKit bug 314934: https://bugs.webkit.org/show_bug.cgi?id=314934
12. Apple App Store Review Guidelines 2.5.6: https://developer.apple.com/app-store/review/guidelines/
13. Mozilla bug 1935277: https://bugzilla.mozilla.org/show_bug.cgi?id=1935277
14. Firefox 139 for developers: https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/139
15. Mozilla bug 1993280: https://bugzilla.mozilla.org/show_bug.cgi?id=1993280
16. Mozilla bug 1958716: https://bugzilla.mozilla.org/show_bug.cgi?id=1958716
17. Chromium `public_key_credential.cc`:
    https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/credentialmanagement/public_key_credential.cc
18. Firefox `PublicKeyCredential.cpp`:
    https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/webauthn/PublicKeyCredential.cpp
19. Bitwarden help, "Log in with passkeys": https://bitwarden.com/help/login-with-passkeys/
20. microsoft/webauthn `webauthn.h` (`WEBAUTHN_API_VERSION_8`):
    https://github.com/microsoft/webauthn/commit/706d98d73a8c3d888e77f0d524f630d551b194c3
21. Yubico, PRF support:
    https://developers.yubico.com/Passkeys/Passkey_concepts/Security_key_capabilities/Pseudo-Random_Function_PRF_Support.html
22. Yubico SDK, hmac-secret: https://docs.yubico.com/yesdk/users-manual/application-fido2/hmac-secret.html
23. 1Password, "Encrypt data saved with passkeys": https://1password.com/blog/encrypt-data-saved-passkeys
24. Bitwarden discussion 13838: https://github.com/orgs/bitwarden/discussions/13838
25. Apple Developer Forums thread 764730 (unreadable to automated fetch):
    https://developer.apple.com/forums/thread/764730

Secondary sources (for example corbado.com's PRF compatibility tests) were used only for the rows
marked UNVERIFIED.

WebAuthn Level 3 (W3C Recommendation, 2026-08-25), §10.1.4 (`prf`), states that create-time results
are optional ("an assertion is needed"):
https://www.w3.org/TR/2026/REC-webauthn-3-20260825/
