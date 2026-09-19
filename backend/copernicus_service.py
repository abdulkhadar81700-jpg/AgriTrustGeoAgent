#!/usr/bin/env python3
"""
AgriTrustGeoAgent - Copernicus Data Space Ecosystem (CDSE) & Sentinel Hub Service
Manages OAuth2 client-credentials authentication, thread-safe token caching,
and secure connectivity verification with Copernicus Data Space Sentinel Hub APIs.

Security Rules:
- CDSE_CLIENT_ID and CDSE_CLIENT_SECRET are strictly server-side.
- Tokens and secrets are never returned in public API payloads, logs, or exceptions.
"""

import binascii
from datetime import datetime, timedelta, timezone
import io
import json
import os
import re
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

# Official Copernicus Data Space Ecosystem & Sentinel Hub endpoints
CDSE_TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
CDSE_USERINFO_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/userinfo"
SENTINEL_HUB_BASE_URL = "https://sh.dataspace.copernicus.eu"
SENTINEL_HUB_CONFORMANCE_URL = f"{SENTINEL_HUB_BASE_URL}/api/v1/catalog/1.0.0/conformance"


def parse_geometry_to_geojson_polygon(boundary: Any) -> Optional[Dict[str, Any]]:
    """
    Normalizes a field boundary from various PostGIS / GeoJSON representations:
    1. GeoJSON dictionary or GeoJSON string
    2. PostGIS EWKT / WKT string (e.g., 'SRID=4326;POLYGON((lng lat, ...))')
    3. PostGIS Hex EWKB string (e.g., '0103000020E6100000...')
    Returns a standard GeoJSON Polygon dictionary:
    {"type": "Polygon", "coordinates": [[[lng, lat], ...]]}
    """
    if not boundary:
        return None

    # Case 1: GeoJSON dict
    if isinstance(boundary, dict):
        if boundary.get("type") == "Polygon" and "coordinates" in boundary:
            coords = boundary["coordinates"]
            if coords and len(coords[0]) >= 3:
                return boundary
        if "coordinates" in boundary:
            coords = boundary["coordinates"]
            if coords and len(coords[0]) >= 3:
                return {"type": "Polygon", "coordinates": coords}

    if isinstance(boundary, str):
        s = boundary.strip()
        # Case 2: Serialized JSON
        if s.startswith("{") and s.endswith("}"):
            try:
                data = json.loads(s)
                if data.get("type") == "Polygon" and "coordinates" in data:
                    return data
                if "coordinates" in data:
                    return {"type": "Polygon", "coordinates": data["coordinates"]}
            except Exception:
                pass

        # Case 3: PostGIS EWKT / WKT
        match = re.search(r'POLYGON\s*\(\(\s*(.+?)\s*\)\)', s, re.IGNORECASE)
        if match:
            coords = []
            for pair in match.group(1).split(','):
                parts = pair.strip().split()
                if len(parts) >= 2:
                    try:
                        lng = float(parts[0])
                        lat = float(parts[1])
                        coords.append([lng, lat])
                    except ValueError:
                        continue
            if len(coords) >= 3:
                if coords[0] != coords[-1]:
                    coords.append(coords[0])
                return {"type": "Polygon", "coordinates": [coords]}

        # Case 4: PostGIS Hex EWKB
        clean_hex = s.replace(r'\x', '').replace('0x', '').strip()
        if len(clean_hex) >= 32 and all(c in '0123456789abcdefABCDEF' for c in clean_hex):
            try:
                raw = binascii.unhexlify(clean_hex)
                byte_order = '<' if raw[0] == 1 else '>'
                geom_type = struct.unpack_from(f"{byte_order}I", raw, 1)[0]
                has_srid = bool(geom_type & 0x20000000)
                base_type = geom_type & 0xFF
                offset = 5
                if has_srid:
                    offset += 4  # skip 4-byte SRID
                if base_type == 3:  # WKBPolygon
                    num_rings = struct.unpack_from(f"{byte_order}I", raw, offset)[0]
                    offset += 4
                    if num_rings > 0:
                        num_points = struct.unpack_from(f"{byte_order}I", raw, offset)[0]
                        offset += 4
                        coords = []
                        for _ in range(num_points):
                            lng, lat = struct.unpack_from(f"{byte_order}dd", raw, offset)
                            coords.append([round(lng, 6), round(lat, 6)])
                            offset += 16
                        if len(coords) >= 3:
                            if coords[0] != coords[-1]:
                                coords.append(coords[0])
                            return {"type": "Polygon", "coordinates": [coords]}
            except Exception as e:
                sys.stderr.write(f"[AgriTrustGeoAgent] Notice: Hex EWKB parse error: {e}\n")

    return None


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

    def process_sentinel2_ndvi(self, bbox: list = None, time_from: str = "2026-08-01T00:00:00Z", time_to: str = "2026-09-19T00:00:00Z") -> Dict[str, Any]:
        """
        Executes a real Sentinel Hub Processing API request for Sentinel-2 L2A NDVI.
        Uses an Evalscript evaluating B04 (Red) and B08 (NIR).
        Does NOT use fake or mock data.
        """
        token, err = self.get_access_token()
        if not token or err:
            return {
                "success": False,
                "status_code": 401 if self.is_configured() else 400,
                "error": err or "Failed to obtain valid CDSE access token",
                "processing_result": None
            }

        # Default bounding box: agricultural area in WGS84 [minLng, minLat, maxLng, maxLat]
        if not bbox:
            bbox = [80.4000, 16.3000, 80.4500, 16.3500]

        evalscript = """//VERSION=3
function setup() {
  return {
    input: ["B04", "B08", "dataMask"],
    output: { bands: 4 }
  };
}

function evaluatePixel(sample) {
  let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);
  if (sample.dataMask == 0) return [0, 0, 0, 0];
  if (ndvi < 0.2) return [0.7, 0.2, 0.1, 1];
  if (ndvi < 0.4) return [0.9, 0.8, 0.2, 1];
  return [0.1, 0.8, 0.2, 1];
}"""

        payload = {
            "input": {
                "bounds": {
                    "bbox": bbox
                },
                "data": [
                    {
                        "type": "sentinel-2-l2a",
                        "dataFilter": {
                            "timeRange": {
                                "from": time_from,
                                "to": time_to
                            },
                            "maxCloudCoverage": 50
                        }
                    }
                ]
            },
            "output": {
                "width": 256,
                "height": 256,
                "responses": [
                    {
                        "identifier": "default",
                        "format": {
                            "type": "image/png"
                        }
                    }
                ]
            },
            "evalscript": evalscript
        }

        req = urllib.request.Request(
            f"{SENTINEL_HUB_BASE_URL}/api/v1/process",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "image/png",
                "User-Agent": "AgriTrustGeoAgent-Backend/2.0"
            }
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                return {
                    "success": True,
                    "status_code": resp.status,
                    "content_type": resp.headers.get("Content-Type", "image/png"),
                    "bytes_received": len(data),
                    "is_png_valid": data.startswith(b'\x89PNG'),
                    "collection": "sentinel-2-l2a",
                    "evalscript_bands": ["B04", "B08", "dataMask"],
                    "output_dimensions": "256x256",
                    "bbox": bbox,
                    "time_range": f"{time_from} to {time_to}",
                    "message": "Sentinel-2 L2A NDVI processing completed successfully via Sentinel Hub Processing API."
                }
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            return {
                "success": False,
                "status_code": e.code,
                "error": f"Sentinel Hub Processing API error (HTTP {e.code})",
                "details": err_body[:300]
            }
        except Exception as e:
            return {
                "success": False,
                "status_code": 500,
                "error": f"Connection error to Sentinel Hub Processing API: {type(e).__name__}"
            }

    def process_field_ndvi(
        self,
        geometry: Dict[str, Any],
        time_from: Optional[str] = None,
        time_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Executes a real Sentinel Hub Processing API request bound to a farmer's registered parcel polygon.
        Uses input.bounds.geometry to mask out pixels outside the boundary.
        Parses the returned Sentinel-2 L2A PNG raster in memory using Pillow to extract:
        - mean_ndvi, min_ndvi, max_ndvi
        - cloud_coverage_pct
        - valid_pixels, total_pixels
        Does NOT use fake or mock satellite data.
        """
        token, err = self.get_access_token()
        if not token or err:
            return {
                "success": False,
                "status_code": 401 if self.is_configured() else 400,
                "error": err or "Failed to obtain valid CDSE access token",
                "processing_result": None
            }

        if not geometry or not isinstance(geometry, dict) or "coordinates" not in geometry:
            return {
                "success": False,
                "status_code": 400,
                "error": "Invalid geometry: Must be a valid GeoJSON Polygon dictionary with coordinates."
            }

        now_utc = datetime.now(timezone.utc)
        if not time_to:
            time_to = now_utc.strftime("%Y-%m-%dT23:59:59Z")
        if not time_from:
            try:
                t_to = datetime.fromisoformat(time_to.replace("Z", "+00:00"))
                time_from = (t_to - timedelta(days=30)).strftime("%Y-%m-%dT00:00:00Z")
            except Exception:
                time_from = (now_utc - timedelta(days=30)).strftime("%Y-%m-%dT00:00:00Z")

        evalscript = """//VERSION=3
function setup() {
  return {
    input: ["B04", "B08", "dataMask"],
    output: { bands: 4 }
  };
}

function evaluatePixel(sample) {
  if (sample.dataMask == 0) return [0, 0, 0, 0];
  
  let denom = sample.B08 + sample.B04;
  let ndvi = denom === 0 ? 0 : (sample.B08 - sample.B04) / denom;
  
  if (ndvi < -1.0) ndvi = -1.0;
  if (ndvi > 1.0) ndvi = 1.0;
  
  let normNdvi = (ndvi + 1.0) / 2.0;
  
  let isCloud = (sample.B04 > 0.35 && sample.B08 > 0.35);
  let g = Math.max(0.0, Math.min(1.0, (ndvi + 0.2) * 1.15));
  let b = isCloud ? 1.0 : (ndvi < 0 ? 0.35 : 0.05);
  let a = isCloud ? 0.96 : 1.0;
  
  return [normNdvi, g, b, a];
}"""

        payload = {
            "input": {
                "bounds": {
                    "geometry": geometry,
                    "properties": {
                        "crs": "http://www.opengis.net/def/crs/EPSG/0/4326"
                    }
                },
                "data": [
                    {
                        "type": "sentinel-2-l2a",
                        "dataFilter": {
                            "timeRange": {
                                "from": time_from,
                                "to": time_to
                            },
                            "maxCloudCoverage": 60,
                            "mosaickingOrder": "mostRecent"
                        }
                    }
                ]
            },
            "output": {
                "width": 256,
                "height": 256,
                "responses": [
                    {
                        "identifier": "default",
                        "format": {
                            "type": "image/png"
                        }
                    }
                ]
            },
            "evalscript": evalscript
        }

        req = urllib.request.Request(
            f"{SENTINEL_HUB_BASE_URL}/api/v1/process",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "image/png",
                "User-Agent": "AgriTrustGeoAgent-Backend/2.0"
            }
        )

        try:
            with urllib.request.urlopen(req, timeout=35) as resp:
                raster_data = resp.read()

                # Parse raster in memory with Pillow to extract canopy statistics
                mean_ndvi = 0.0
                min_ndvi = 0.0
                max_ndvi = 0.0
                cloud_coverage_pct = 0.0
                total_parcel_pixels = 0
                valid_pixel_count = 0
                cloud_pixels = 0

                try:
                    im = Image.open(io.BytesIO(raster_data))
                    if im.mode != "RGBA":
                        im = im.convert("RGBA")
                    raw_bytes = im.tobytes()

                    ndvi_sum = 0.0
                    temp_min = 1.0
                    temp_max = -1.0

                    for i in range(0, len(raw_bytes), 4):
                        r = raw_bytes[i]
                        g = raw_bytes[i + 1]
                        b = raw_bytes[i + 2]
                        a = raw_bytes[i + 3]

                        if a == 0:
                            continue  # Masked outside parcel boundary

                        total_parcel_pixels += 1

                        # Cloud detection flag (alpha ~244 from 0.96 tag, or high diffuse reflectance)
                        if a < 250 or (b > 240 and r > 200 and g > 200):
                            cloud_pixels += 1
                            continue

                        val = (r / 255.0) * 2.0 - 1.0
                        val = max(-1.0, min(1.0, round(val, 4)))
                        ndvi_sum += val
                        valid_pixel_count += 1
                        if val < temp_min:
                            temp_min = val
                        if val > temp_max:
                            temp_max = val

                    if valid_pixel_count > 0:
                        mean_ndvi = round(ndvi_sum / valid_pixel_count, 4)
                        min_ndvi = round(temp_min, 4)
                        max_ndvi = round(temp_max, 4)
                    else:
                        mean_ndvi = 0.0
                        min_ndvi = 0.0
                        max_ndvi = 0.0

                    if total_parcel_pixels > 0:
                        cloud_coverage_pct = round((cloud_pixels / total_parcel_pixels) * 100.0, 2)
                    else:
                        cloud_coverage_pct = 0.0

                except Exception as parse_err:
                    sys.stderr.write(f"[AgriTrustGeoAgent] Notice parsing Sentinel raster: {parse_err}\n")

                return {
                    "success": True,
                    "status_code": resp.status,
                    "mean_ndvi": mean_ndvi,
                    "min_ndvi": min_ndvi,
                    "max_ndvi": max_ndvi,
                    "cloud_coverage_pct": cloud_coverage_pct,
                    "valid_pixels": valid_pixel_count,
                    "total_pixels": total_parcel_pixels,
                    "acquisition_date": time_to.split("T")[0],
                    "satellite_platform": "Sentinel-2 L2A",
                    "raster_bytes": raster_data,
                    "bytes_received": len(raster_data),
                    "is_png_valid": raster_data.startswith(b'\x89PNG'),
                    "time_range": f"{time_from} to {time_to}",
                    "message": "Sentinel-2 L2A NDVI processing completed successfully for parcel AOI."
                }
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            return {
                "success": False,
                "status_code": e.code,
                "error": f"Sentinel Hub Processing API error (HTTP {e.code})",
                "details": err_body[:300]
            }
        except Exception as e:
            return {
                "success": False,
                "status_code": 500,
                "error": f"Connection error to Sentinel Hub Processing API: {type(e).__name__}"
            }


# Singleton service instance
copernicus_service = CopernicusService()
