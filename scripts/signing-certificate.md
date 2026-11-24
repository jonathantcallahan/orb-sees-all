# The macOS signing certificate

Demian's Mac builds are signed with a self-signed certificate named **Demian Code Signing**. It isn't Apple's: Gatekeeper still treats the app as unidentified, so a downloaded copy still needs the `xattr` step in the README.

It's there because macOS remembers your answers to its privacy prompts (files in Documents, Downloads, Music, Photos and the like; controlling Spotify and Music) by the app's signature. An ad hoc signature changes with every build, so macOS asked again after every update. A certificate's signature names the certificate instead (`certificate leaf = H"…"`), which stays the same from one build to the next.

The hardened runtime is off (`bundle.macOS.hardenedRuntime` in `src-tauri/tauri.conf.json`). It's only needed for Apple's notarization, and it would block Demian's Apple Events to Spotify and Music without an extra entitlement.

## Where it's kept

- `~/.tauri/demian-signing.p12`: the certificate and its private key, and `~/.tauri/demian-signing.p12.password`, its password. Keep both: a new certificate would be a different signature, and macOS would ask everything again once.
- Your login keychain: imported from the `.p12`, usable by `codesign` only. `scripts/install-app.sh` signs with it when it's there.
- The repo's Actions secrets `MACOS_CERTIFICATE` (the `.p12`, base64) and `MACOS_CERTIFICATE_PASSWORD`. The release workflow imports them into a temporary keychain. Without them, release builds are signed ad hoc.

## On a new Mac

```bash
security import ~/.tauri/demian-signing.p12 -k ~/Library/Keychains/login.keychain-db -f pkcs12 -P "$(cat ~/.tauri/demian-signing.p12.password)" -T /usr/bin/codesign
```

## If it's lost

Make a new one, then import it as above and update both secrets:

```bash
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -keyout key.pem -out cert.pem -subj "/CN=Demian Code Signing" -addext "basicConstraints=critical,CA:false" -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning"
```

```bash
/usr/bin/openssl rand -base64 24 | tr -d '\n' > ~/.tauri/demian-signing.p12.password && chmod 600 ~/.tauri/demian-signing.p12.password
```

```bash
/usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -name "Demian Code Signing" -out ~/.tauri/demian-signing.p12 -passout file:$HOME/.tauri/demian-signing.p12.password && rm key.pem cert.pem
```

```bash
base64 -i ~/.tauri/demian-signing.p12 | gh secret set MACOS_CERTIFICATE && gh secret set MACOS_CERTIFICATE_PASSWORD < ~/.tauri/demian-signing.p12.password
```

These use macOS's own `openssl` (LibreSSL), not Homebrew's: `security import` can't read a `.p12` made with OpenSSL 3's defaults.
