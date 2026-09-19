#!/usr/bin/env python3
"""
AgriTrustGeoAgent - Copernicus Data Space Ecosystem (CDSE) & Sentinel Hub Service
Manages OAuth2 client-credentials authentication, thread-safe token caching,
and secure connectivity verification with Copernicus Data Space Sentinel Hub APIs.

Security Rules:
- CDSE_CLIENT_ID and CDSE_CLIENT_SECRET are strictly server-side.
- Tokens and secrets are never returned in public API payloads, logs, or exceptions.
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional, Tuple

# Official Copernicus Data Space Ecosystem & Sentinel Hub endpoints
CDSE_TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
CDSE_USERINFO_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/userinfo"
SENTINEL_HUB_BASE_URL = "https://sh.dataspace.copernicus.eu"
SENTINEL_HUB_CONFORMANCE_URL = f"{SENTINEL_HUB_BASE_URL}/api/v1/catalog/1.0.0/conformance"


class CopernicusService:
    """Thread-safe client for Copernicus Data Space Sentinel Hub authentication and services."""

    def __init__(self):
        self._lock = threading.Lock()
        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0.0
        self._last_auth_attempt: float = 0.0
        self._last_error: Optional[str] = None

    def _get_credentials(self) -> Tuple[str, str]:
        """Retrieves and normalizes CDSE client credentials from environment variables."""
        client_id = os.environ.get("CDSE_CLIENT_ID", "").strip()
        client_secret = os.environ.get("CDSE_CLIENT_SECRET", "").strip()

        # Reject common template placeholders
        if "your-cdse-client-id" in client_id.lower():
            client_id = ""
        if "your-cdse-client-secret" in client_secret.lower():
            client_secret = ""

        return client_id, client_secret

    def is_configured(self) -> bool:
        """Returns True if valid Copernicus Data Space credentials are present in the environment."""
        client_id, client_secret = self._get_credentials()
        return bool(client_id and client_secret)

    def get_access_token(self, force_refresh: bool = False) -> Tuple[Optional[str], Optional[str]]:
        """
        Retrieves a valid bearer access token, using an in-memory cache when still fresh.
        Returns a tuple: (access_token, error_message).
        
        Thread-safe: Multiple concurrent requests will wait for a single refresh rather
        than hammering the CDSE identity provider.
        """
        client_id, client_secret = self._get_credentials()
        if not client_id or not client_secret:
            return None, "Copernicus Data Space credentials (CDSE_CLIENT_ID / CDSE_CLIENT_SECRET) unconfigured."

        # Quick check without acquiring lock if token is comfortably valid (> 60 seconds left)
        now = time.time()
        if not force_refresh and self._access_token and (self._token_expires_at - now > 60):
            return self._access_token, None

        with self._lock:
            # Double-checked locking
            now = time.time()
            if not force_refresh and self._access_token and (self._token_expires_at - now > 60):
                return self._access_token, None

            # Rate limit backoff: Don't hammer token endpoint if last attempt failed < 3 seconds ago
            if now - self._last_auth_attempt < 3 and self._last_error:
                return None, f"Rate-limited auth retry backoff: {self._last_error}"

            self._last_auth_attempt = now

            payload_data = urllib.parse.urlencode({
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret
            }).encode("utf-8")

            req = urllib.request.Request(
                CDSE_TOKEN_URL,
                data=payload_data,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                    "User-Agent": "AgriTrustGeoAgent-Backend/2.0"
                }
            )

            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    if resp.status != 200:
                        err_msg = f"CDSE token endpoint returned HTTP status {resp.status}"
                        self._last_error = err_msg
                        return None, err_msg

                    body = json.loads(resp.read().decode("utf-8"))
                    token = body.get("access_token")
                    expires_in = body.get("expires_in", 3600)

                    if not token:
                        err_msg = "CDSE response did not contain access_token."
                        self._last_error = err_msg
                        return None, err_msg

                    # Cache token with safety buffer
                    self._access_token = token
                    self._token_expires_at = now + float(expires_in)
                    self._last_error = None

                    # Format clean log without exposing secret or token
                    sys.stderr.write(
                        f"[AgriTrustGeoAgent] Copernicus Data Space token acquired successfully (valid for {expires_in}s).\n"
                    )
                    return self._access_token, None

            except urllib.error.HTTPError as e:
                # Sanitize error to avoid leaking credentials
                err_detail = "Authentication failed (401 Unauthorized / Invalid Client)" if e.code in (400, 401) else f"HTTP Error {e.code}"
                self._last_error = err_detail
                sys.stderr.write(f"[AgriTrustGeoAgent] CDSE Authentication HTTP Error: {err_detail}\n")
                return None, err_detail
            except urllib.error.URLError as e:
                err_detail = f"Network connection failed: {e.reason}"
                self._last_error = err_detail
                sys.stderr.write(f"[AgriTrustGeoAgent] CDSE Connection Error: {err_detail}\n")
                return None, err_detail
            except Exception as e:
                err_detail = f"Unexpected error during token acquisition: {type(e).__name__}"
                self._last_error = err_detail
                sys.stderr.write(f"[AgriTrustGeoAgent] CDSE Auth Exception: {err_detail}\n")
                return None, err_detail

    def verify_sentinel_hub_connectivity(self, token: str) -> Tuple[bool, Optional[str]]:
        """
        Verifies that the acquired token successfully authorizes against Sentinel Hub APIs.
        Returns: (is_valid, error_message)
        """
        req = urllib.request.Request(
            SENTINEL_HUB_CONFORMANCE_URL,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": "AgriTrustGeoAgent-Backend/2.0"
            }
        )
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                if resp.status in (200, 204):
                    return True, None
                return False, f"Sentinel Hub conformance check returned HTTP {resp.status}"
        except urllib.error.HTTPError as e:
            return False, f"Sentinel Hub API authorization error (HTTP {e.code})"
        except Exception as e:
            return False, f"Sentinel Hub API connection error: {type(e).__name__}"

    def get_health_status(self) -> Dict[str, Any]:
        """
        Generates a comprehensive, secure health and authentication status payload.
        NEVER exposes tokens, client IDs, or client secrets.
        """
        is_cfg = self.is_configured()
        now = time.time()

        if not is_cfg:
            return {
                "status": "UNCONFIGURED",
                "provider": "Copernicus Data Space Ecosystem (Sentinel Hub)",
                "configured": False,
                "authenticated": False,
                "token_cached": False,
                "token_expires_in_seconds": 0,
                "sentinel_hub_reachable": False,
                "endpoints": {
                    "token_url": CDSE_TOKEN_URL,
                    "sentinel_hub_base_url": SENTINEL_HUB_BASE_URL
                },
                "message": "Copernicus Data Space Ecosystem credentials are not configured in environment.",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
            }

        token, err = self.get_access_token()
        if not token or err:
            return {
                "status": "AUTHENTICATION_FAILED",
                "provider": "Copernicus Data Space Ecosystem (Sentinel Hub)",
                "configured": True,
                "authenticated": False,
                "token_cached": False,
                "token_expires_in_seconds": 0,
                "sentinel_hub_reachable": False,
                "endpoints": {
                    "token_url": CDSE_TOKEN_URL,
                    "sentinel_hub_base_url": SENTINEL_HUB_BASE_URL
                },
                "error": err or "Failed to obtain token from CDSE identity provider",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
            }

        # Token is valid; now verify Sentinel Hub API authorization
        sh_ok, sh_err = self.verify_sentinel_hub_connectivity(token)
        ttl = max(0, int(self._token_expires_at - now))

        return {
            "status": "HEALTHY" if sh_ok else "SERVICE_DEGRADED",
            "provider": "Copernicus Data Space Ecosystem (Sentinel Hub)",
            "configured": True,
            "authenticated": True,
            "token_cached": True,
            "token_expires_in_seconds": ttl,
            "sentinel_hub_reachable": sh_ok,
            "endpoints": {
                "token_url": CDSE_TOKEN_URL,
                "sentinel_hub_base_url": SENTINEL_HUB_BASE_URL
            },
            "api_check": "passed" if sh_ok else f"warning: {sh_err}",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        }


# Singleton service instance
copernicus_service = CopernicusService()
