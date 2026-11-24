import type { AppCatalog } from "./android";

/** 安卓 App 的英文文案（#204）：键和 app-zh.ts 完全一样，照 docs/brand/README.md 的"英文"写。 */
export const appEn: AppCatalog = {
  app_name: "{brand}",
  cancel: "Cancel",
  back: "Back",

  connect_title: "Connect to server",
  connect_hint: "Enter the address of your {brand} site, for example seekcloud.example.com.",
  connect_address: "Server address",
  connect_button: "Connect",
  connect_connecting: "Connecting…",
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
  connect_edit_title: "Change server address",
  connect_edit_hint: "Enter the new address of your {brand} site. This device stays signed in.",
  connect_move_title: "Keep signed in",
  connect_move_body:
    "The new address {host} will use this device's sign-in from the old address. Make sure it is the same {brand} site. If it is not, cancel and sign out at the old address.",
  connect_move_confirm: "Continue",

  login_title: "Sign in",
  login_server: "Sign in to {host}",
  login_password: "Admin password",
  login_button: "Sign in",
  login_signing_in: "Signing in…",
  login_signed_out: "This device was signed out. Sign in again.",
  login_setup_required:
    "This site has no admin password yet. Open the site in a browser and complete the initial setup, then sign in.",
  login_open_browser: "Open in browser",
  login_check_again: "Check again",
  login_code_title: "Two-step verification",
  login_code_hint: "Enter the 6-digit code from your authenticator app, or a recovery code.",
  login_code: "Code",
  login_verify: "Verify",
  login_verifying: "Verifying…",
  switch_server: "Switch server",

  home_signed_in: "Signed in to {host}",
  home_greeting: "Hello, {name}",
  sign_out: "Sign out",
  sign_out_title: "Sign out",
  sign_out_body: "This device will be signed out of {host}.",

  servers_title: "Servers",
  servers_add: "Add server",
  servers_current: "In use",
  servers_signed_in: "Signed in",
  servers_signed_out: "Signed out",
  servers_remove: "Remove",
  servers_remove_title: "Remove server",
  servers_remove_body:
    "{host} will be removed from this device, and this device will be signed out of it.",

  offline_title: "Unable to connect to the site",
  offline_retry: "Retry",
  offline_retrying: "Retrying…",
  offline_edit_address: "Change address",

  update_title: "App update required",
  update_body:
    "{host} requires app version {version} or later. This is version {current}. Download the new version, then connect again.",
  update_download: "Download new version",
};
