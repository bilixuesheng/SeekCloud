import type { AppCatalog } from "./android";

/** 安卓 App 的英文文案（#204）：键和 app-zh.ts 完全一样，照 docs/brand/README.md 的"英文"写。 */
export const appEn: AppCatalog = {
  app_name: "{brand}",
  cancel: "Cancel",

  connect_title: "Connect to server",
  connect_hint: "Enter the address of your {brand} site, for example seekcloud.example.com.",
  connect_address: "Server address",
  connect_button: "Connect",
  connect_connecting: "Connecting…",
  connect_connected: "Connected to {host}",
  connect_invalid: "Invalid address. Enter a domain name or an IP address, optionally with a port.",
  connect_unreachable:
    "Unable to connect to this address. Check the address and your network, then try again.",
  connect_not_seekcloud:
    "There is no {brand} site at this address. Check that the address is correct.",
  connect_unavailable: "The {brand} site is temporarily unavailable. Try again later.",
  connect_tls_failure: "Unable to establish a secure connection to this server.",
  connect_app_too_old: "This site requires app version {version} or later. Update the app first.",
  connect_cleartext_title: "Unencrypted connection",
  connect_cleartext_body:
    "This address uses HTTP. The connection is not encrypted, so people on the same network can see your password and code. Only connect this way on a trusted private network.",
  connect_cleartext_confirm: "Connect anyway",
  connect_cert_title: "Untrusted certificate",
  connect_cert_body:
    "This server's certificate is not trusted by the system and may be self-signed. Make sure the fingerprint below matches the certificate on the server before you continue.",
  connect_cert_changed_title: "Certificate changed",
  connect_cert_changed_body:
    "This server's certificate is different from the one you confirmed before. If the server's certificate was not replaced, the connection may have been intercepted. Confirm the new certificate's fingerprint before you continue.",
  connect_cert_fingerprint: "SHA-256 fingerprint",
  connect_cert_trust: "Trust this certificate",
};
