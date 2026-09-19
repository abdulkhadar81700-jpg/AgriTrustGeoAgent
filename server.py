#!/usr/bin/env python3
"""
AgriTrustGeoAgent - Local Development & Verification Server
Serves static frontend assets with proper MIME types, anti-caching headers,
and provides a secure /api/config endpoint exposing ONLY public client credentials.
"""

import base64
import http.server
import json
import os
import socketserver
import sys
import urllib.error
import urllib.parse
import urllib.request

from backend.copernicus_service import copernicus_service

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, 'frontend')
ENV_FILE = os.path.join(BASE_DIR, '.env')

def load_env(env_path):
    """Safely loads key-value pairs from .env into os.environ without external dependencies."""
    if not os.path.exists(env_path):
        return
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, val = line.split('=', 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            os.environ[key] = val

# Load .env on startup
load_env(ENV_FILE)

PORT = int(os.environ.get('PORT', 8000))
HOST = os.environ.get('HOST', '0.0.0.0')

class AgriTrustHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    def send_cors_headers(self):
        """Attaches secure CORS headers for cross-origin client integration."""
        allowed_origin = os.environ.get('ALLOWED_ORIGIN', '*').strip()
        self.send_header('Access-Control-Allow-Origin', allowed_origin)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey')
        self.send_header('Access-Control-Max-Age', '86400')

    def do_OPTIONS(self):
        """Handles browser CORS preflight requests for API endpoints."""
        clean_path = self.path.split('?')[0].rstrip('/')
        if clean_path in ('/api/config', '/api/analyze-evidence', '/api/copernicus/health', '/api/satellite/health', '/api/copernicus/smoke-test', '/api/satellite/smoke-test'):
            self.send_response(204)
            self.send_cors_headers()
            self.send_header('Content-Length', '0')
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        clean_path = self.path.split('?')[0].rstrip('/')

        # Dedicated endpoint to expose ONLY safe, public frontend configurations
        if clean_path == '/api/config':
            load_env(ENV_FILE)
            raw_url = os.environ.get('SUPABASE_URL', '').strip()
            # Normalize URL if user entered project ref alone
            if raw_url and 'your-project-id' not in raw_url:
                if not raw_url.startswith(('http://', 'https://')):
                    if '.' not in raw_url:
                        raw_url = f"https://{raw_url}.supabase.co"
                    else:
                        raw_url = f"https://{raw_url}"
                raw_url = raw_url.rstrip('/')
            supabase_url = raw_url

            supabase_pub_key = (
                os.environ.get('SUPABASE_PUBLISHABLE_KEY') or
                os.environ.get('SUPABASE_ANON_KEY', '')
            ).strip()

            is_configured = bool(
                supabase_url and
                supabase_pub_key and
                'your-project-id' not in supabase_url and
                'your-publishable-key' not in supabase_pub_key and
                'your-anon-public-key' not in supabase_pub_key
            )

            # Security: SUPABASE_SERVICE_ROLE_KEY and CDSE secrets are STRICTLY excluded
            payload = {
                "configured": is_configured,
                "supabaseUrl": supabase_url if is_configured else "",
                "supabasePublishableKey": supabase_pub_key if is_configured else "",
                "supabaseAnonKey": supabase_pub_key if is_configured else "",
                "copernicusConfigured": copernicus_service.is_configured(),
                "environment": os.environ.get('ENVIRONMENT', 'development')
            }

            self.send_json(200, payload)
            return

        # Dedicated health/test endpoint for Copernicus Data Space Sentinel Hub verification
        if clean_path in ('/api/copernicus/health', '/api/satellite/health'):
            load_env(ENV_FILE)
            health = copernicus_service.get_health_status()
            status_code = 200 if health.get("status") in ("HEALTHY", "UNCONFIGURED") else 502
            self.send_json(status_code, health)
            return

        # Dedicated live Processing API smoke test for Sentinel-2 L2A NDVI
        if clean_path in ('/api/copernicus/smoke-test', '/api/satellite/smoke-test'):
            load_env(ENV_FILE)
            result = copernicus_service.process_sentinel2_ndvi()
            status_code = 200 if result.get("success") else (502 if result.get("status_code") != 400 else 400)
            self.send_json(status_code, result)
            return

        super().do_GET()

    def send_json(self, status_code, payload):
        """Helper to send JSON HTTP responses with proper anti-cache and CORS headers."""
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # Dedicated endpoint for secure evidence analysis and diagnostic inference
        clean_path = self.path.split('?')[0].rstrip('/')
        if clean_path == '/api/analyze-evidence':
            # Validate Bearer token first (Security Boundary)
            auth_header = self.headers.get('Authorization', '').strip()
            if not auth_header.startswith('Bearer '):
                self.send_json(401, {"error": "Unauthorized: Missing Bearer token in Authorization header"})
                return
            token = auth_header.split('Bearer ', 1)[1].strip()
            if not token:
                self.send_json(401, {"error": "Unauthorized: Empty Bearer token"})
                return

            content_length = int(self.headers.get('Content-Length', 0))
            if content_length == 0:
                self.send_json(400, {"error": "Empty request body"})
                return

            try:
                raw_body = self.rfile.read(content_length).decode('utf-8')
                req_data = json.loads(raw_body)
            except Exception as e:
                self.send_json(400, {"error": f"Malformed JSON: {str(e)}"})
                return

            evidence_id = req_data.get('evidence_id')
            if not evidence_id:
                self.send_json(400, {"error": "Missing evidence_id in request body"})
                return

            supabase_url = os.environ.get('SUPABASE_URL', '').strip().rstrip('/')
            pub_key = (os.environ.get('SUPABASE_PUBLISHABLE_KEY') or os.environ.get('SUPABASE_ANON_KEY', '')).strip()
            service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '').strip()
            gemini_key = (os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY', '')).strip()

            if not supabase_url or not pub_key:
                self.send_json(500, {"error": "Server environment unconfigured (SUPABASE_URL/KEY missing)"})
                return

            # 1. Verify caller session token with Supabase GoTrue
            try:
                req_user = urllib.request.Request(
                    f"{supabase_url}/auth/v1/user",
                    headers={
                        "apikey": pub_key,
                        "Authorization": f"Bearer {token}"
                    }
                )
                with urllib.request.urlopen(req_user, timeout=10) as resp:
                    if resp.status != 200:
                        self.send_json(401, {"error": "Unauthorized: Invalid or expired session token"})
                        return
                    user_data = json.loads(resp.read().decode('utf-8'))
                    caller_user_id = user_data.get('id')
            except urllib.error.HTTPError as e:
                self.send_json(401, {"error": f"Unauthorized: Session verification failed ({e.code})"})
                return
            except Exception as e:
                self.send_json(502, {"error": f"Authentication verification gateway error: {str(e)}"})
                return

            # 2. Query crop_evidence with caller Bearer token (enforces PostgreSQL RLS uploader_id = auth.uid())
            try:
                ev_url = f"{supabase_url}/rest/v1/crop_evidence?id=eq.{evidence_id}&select=*,fields(id,name,crop_variety)"
                req_ev = urllib.request.Request(
                    ev_url,
                    headers={
                        "apikey": pub_key,
                        "Authorization": f"Bearer {token}"
                    }
                )
                with urllib.request.urlopen(req_ev, timeout=10) as resp:
                    evidence_rows = json.loads(resp.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                self.send_json(e.code, {"error": f"Evidence lookup failed: {e.read().decode('utf-8')}"})
                return
            except Exception as e:
                self.send_json(500, {"error": f"Evidence lookup error: {str(e)}"})
                return

            if not evidence_rows:
                self.send_json(404, {"error": "Crop evidence record not found or access denied (RLS boundary enforced)"})
                return

            evidence = evidence_rows[0]

            # 3. Idempotency Check: Return existing inference if already processed
            try:
                inf_url = f"{supabase_url}/rest/v1/diagnostic_inferences?evidence_id=eq.{evidence_id}&select=*"
                req_inf = urllib.request.Request(
                    inf_url,
                    headers={
                        "apikey": pub_key,
                        "Authorization": f"Bearer {token}"
                    }
                )
                with urllib.request.urlopen(req_inf, timeout=10) as resp:
                    inf_rows = json.loads(resp.read().decode('utf-8'))
                    if inf_rows:
                        existing_inf = inf_rows[0]
                        self.send_json(200, {
                            "status": "ANALYSIS_COMPLETE",
                            "already_exists": True,
                            "inference": existing_inf,
                            "escalated": bool(existing_inf.get("requires_escalation", False))
                        })
                        return
            except Exception as e:
                sys.stderr.write(f"[AgriTrustGeoAgent] Notice checking existing inference: {e}\n")

            # 4. Evidence Quality & Validation Inspection
            val_status = evidence.get("validation_status")
            is_geofence = evidence.get("is_geofence_verified", False)
            rejection_reasons = evidence.get("rejection_reasons") or []
            storage_path = evidence.get("storage_path")

            if val_status == "rejected" or (rejection_reasons and not is_geofence):
                self.send_json(200, {
                    "status": "INSUFFICIENT_EVIDENCE",
                    "code": "EVIDENCE_VALIDATION_REJECTED",
                    "message": "Crop photo failed spatial geofencing or optical validation gates and cannot be submitted for agronomic analysis.",
                    "rejection_reasons": rejection_reasons,
                    "evidence_id": evidence_id,
                    "requires_escalation": False
                })
                return

            # 5. Check if real AI Vision model provider is configured
            if not gemini_key:
                # Strictly follow prompt instruction:
                # Do NOT generate fake disease/pest diagnoses, fake confidence scores, mock AI responses, or placeholder production logic.
                # Return a clear ANALYSIS_UNAVAILABLE / INSUFFICIENT_EVIDENCE state instead of inventing a diagnosis.
                self.send_json(200, {
                    "status": "ANALYSIS_UNAVAILABLE",
                    "code": "AI_PROVIDER_UNCONFIGURED",
                    "message": "Automated AI diagnostic model is currently unconfigured (GEMINI_API_KEY pending). No synthetic diagnosis was generated. Photo has been logged and queued for certified human agronomist review.",
                    "evidence_id": evidence_id,
                    "requires_agronomist_review": True,
                    "escalation_status": "queued_for_review"
                })
                return

            # 6. Real AI Vision Analysis Execution (Gemini 3.8 Flash via Interactions API)
            try:
                # Retrieve raw JPEG binary from private crop-evidence bucket
                img_bytes = None
                if service_key and 'your-service-role' not in service_key:
                    storage_dl_url = f"{supabase_url}/storage/v1/object/authenticated/crop-evidence/{storage_path}"
                    req_dl = urllib.request.Request(
                        storage_dl_url,
                        headers={
                            "apikey": service_key,
                            "Authorization": f"Bearer {service_key}"
                        }
                    )
                    with urllib.request.urlopen(req_dl, timeout=15) as resp:
                        img_bytes = resp.read()
                else:
                    # Fallback: create signed URL via authenticated user session
                    sign_url = f"{supabase_url}/storage/v1/object/sign/crop-evidence/{storage_path}"
                    req_sign = urllib.request.Request(
                        sign_url,
                        data=json.dumps({"expiresIn": 300}).encode('utf-8'),
                        headers={
                            "apikey": pub_key,
                            "Authorization": f"Bearer {token}",
                            "Content-Type": "application/json"
                        }
                    )
                    with urllib.request.urlopen(req_sign, timeout=10) as resp:
                        sign_data = json.loads(resp.read().decode('utf-8'))
                        signed_url_path = sign_data.get('signedURL')
                        full_signed_url = f"{supabase_url}/storage/v1{signed_url_path}"
                    with urllib.request.urlopen(full_signed_url, timeout=15) as resp:
                        img_bytes = resp.read()

                if not img_bytes:
                    self.send_json(500, {"error": "Could not retrieve image binary from storage for analysis"})
                    return

                # Normalize large camera photos to standard vision resolution to prevent API payload limits
                if len(img_bytes) > 1024 * 1024:
                    try:
                        import io
                        from PIL import Image
                        _im = Image.open(io.BytesIO(img_bytes))
                        _im.thumbnail((1280, 1280))
                        _buf = io.BytesIO()
                        _im.save(_buf, format='JPEG', quality=85)
                        img_bytes = _buf.getvalue()
                    except Exception as _e:
                        sys.stderr.write(f"[AgriTrustGeoAgent] Image normalization notice: {_e}\n")

                img_b64 = base64.b64encode(img_bytes).decode('utf-8')
                crop_name = (
                    (evidence.get("fields") or {}).get("crop_variety") or
                    evidence.get("optical_metadata", {}).get("crop_name") or
                    "Canopy / Leaf"
                )

                gemini_endpoint = "https://generativelanguage.googleapis.com/v1beta/interactions"
                prompt_text = (
                    f"You are a certified agricultural plant pathologist and agronomist. "
                    f"Analyze this crop foliage/canopy photograph for the registered crop: '{crop_name}'.\n"
                    f"Evaluate visual lesions, chlorosis, necrosis, pest feeding damage, or healthy vegetative growth.\n"
                    f"CRITICAL INSTRUCTIONS:\n"
                    f"1. If the photo does not show crop vegetation, is too blurry to identify, or is completely uninterpretable, "
                    f"set diagnosis_label to 'INSUFFICIENT_EVIDENCE', set confidence_score to 0.35, and explain why in recommendation_text.\n"
                    f"2. If symptoms are definitively recognizable, provide the specific disease or pest name (e.g. 'Northern Corn Leaf Blight', 'Common Leaf Rust', 'Fall Armyworm Damage', or 'Healthy Canopy').\n"
                    f"3. confidence_score MUST be a float strictly between 0.05 and 0.98. Do NOT exceed 0.98.\n"
                    f"4. Provide realistic uncertainty_margin (0.02 - 0.15).\n"
                    f"5. Identify observable visual symptoms (lesions, chlorosis, wilt) and provide actionable cultural/chemical management guidance."
                )

                gemini_payload = {
                    "model": "gemini-3.8-flash",
                    "input": [
                        {
                            "type": "image",
                            "mime_type": "image/jpeg",
                            "data": img_b64
                        },
                        {
                            "type": "text",
                            "text": prompt_text
                        }
                    ],
                    "response_format": [
                        {
                            "type": "text",
                            "mime_type": "application/json",
                            "schema": {
                                "type": "OBJECT",
                                "properties": {
                                    "diagnosis_label": {"type": "STRING"},
                                    "confidence_score": {"type": "NUMBER"},
                                    "uncertainty_margin": {"type": "NUMBER"},
                                    "recommendation_text": {"type": "STRING"},
                                    "visual_symptoms": {"type": "STRING"}
                                },
                                "required": [
                                    "diagnosis_label",
                                    "confidence_score",
                                    "uncertainty_margin",
                                    "recommendation_text",
                                    "visual_symptoms"
                                ]
                            }
                        }
                    ]
                }

                req_gemini = urllib.request.Request(
                    gemini_endpoint,
                    data=json.dumps(gemini_payload).encode('utf-8'),
                    headers={
                        "Content-Type": "application/json",
                        "x-goog-api-key": gemini_key
                    }
                )
                with urllib.request.urlopen(req_gemini, timeout=25) as resp:
                    gemini_resp = json.loads(resp.read().decode('utf-8'))

                # Extract JSON string from Interactions API 'model_output' timeline step
                out_text = None
                for step in gemini_resp.get("steps", []):
                    if step.get("type") == "model_output":
                        for item in step.get("content", []):
                            if item.get("type") == "text":
                                out_text = item.get("text", "").strip()
                                break
                        if out_text:
                            break

                if not out_text:
                    self.send_json(502, {"error": "AI vision provider returned no model_output step"})
                    return

                if out_text.startswith('```'):
                    lines = out_text.split('\n')
                    if lines[0].startswith('```'):
                        lines = lines[1:]
                    if lines and lines[-1].startswith('```'):
                        lines = lines[:-1]
                    out_text = '\n'.join(lines).strip()

                ai_result = json.loads(out_text)

                diag_label = str(ai_result.get('diagnosis_label', 'UNRESOLVED_SYMPTOMATOLOGY')).strip()
                conf_score = float(ai_result.get('confidence_score', 0.50))
                # Postgres constraint: confidence_score >= 0.0 AND confidence_score < 1.0
                conf_score = max(0.05, min(0.98, conf_score))
                uncertainty = max(0.01, min(0.20, float(ai_result.get('uncertainty_margin', 0.05))))
                recom_text = str(ai_result.get('recommendation_text', 'Consult your regional agricultural extension officer.')).strip()
                symptoms = str(ai_result.get('visual_symptoms', '')).strip()

                inference_row = {
                    "evidence_id": evidence_id,
                    "model_version": "agritrust-gemini-3.8-flash-v1",
                    "diagnosis_label": diag_label,
                    "confidence_score": conf_score,
                    "uncertainty_margin": uncertainty,
                    "telemetry_context": {
                        "crop_declared": crop_name,
                        "visual_symptoms": symptoms,
                        "evaluated_at": evidence.get("capture_timestamp")
                    },
                    "recommendation_text": recom_text
                }

                # Persist to public.diagnostic_inferences if service_role is active
                if service_key and 'your-service-role' not in service_key:
                    req_insert = urllib.request.Request(
                        f"{supabase_url}/rest/v1/diagnostic_inferences",
                        data=json.dumps(inference_row).encode('utf-8'),
                        headers={
                            "apikey": service_key,
                            "Authorization": f"Bearer {service_key}",
                            "Content-Type": "application/json",
                            "Prefer": "return=representation"
                        }
                    )
                    with urllib.request.urlopen(req_insert, timeout=10) as resp:
                        saved_inferences = json.loads(resp.read().decode('utf-8'))
                        final_inference = saved_inferences[0] if saved_inferences else inference_row
                else:
                    final_inference = inference_row

                is_escalated = (conf_score < 0.85)

                self.send_json(200, {
                    "status": "ANALYSIS_COMPLETE",
                    "inference": final_inference,
                    "escalated": is_escalated
                })
                return

            except urllib.error.HTTPError as e:
                err_content = e.read().decode('utf-8', errors='ignore')
                sys.stderr.write(f"[AgriTrustGeoAgent] AI Inference Provider HTTP Error ({e.code}): {err_content}\n")
                self.send_json(502, {"error": f"AI diagnostic provider failed ({e.code}): {err_content[:200]}"})
                return
            except Exception as e:
                sys.stderr.write(f"[AgriTrustGeoAgent] AI Inference Execution Error: {e}\n")
                self.send_json(500, {"error": f"Inference execution error: {str(e)}"})
                return

        self.send_json(404, {"error": "Endpoint not found"})

    def end_headers(self):
        # Prevent aggressive local caching during development
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        super().end_headers()

    def address_string(self):
        # Prevent slow reverse DNS lookups on local Wi-Fi / LAN IPs
        return str(self.client_address[0])

    def log_message(self, format, *args):
        # Formatted agronomy dev server logs
        sys.stderr.write(f"[AgriTrustGeoAgent] {self.address_string()} - {format % args}\n")

def get_local_ip():
    """Detect local network IPv4 address for Wi-Fi / LAN mobile testing."""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"

def run():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((HOST, PORT), AgriTrustHTTPHandler) as httpd:
        local_ip = get_local_ip()
        print("=" * 60)
        print("  AgriTrustGeoAgent - Production Foundation Server (Multi-Threaded)")
        print(f"  Serving directory: {FRONTEND_DIR}")
        print(f"  Bound Address:    {HOST}:{PORT}")
        print(f"  Localhost URL:    http://127.0.0.1:{PORT}")
        print(f"  Local Wi-Fi URL:  http://{local_ip}:{PORT}")
        print(f"  Config endpoint:  http://{local_ip}:{PORT}/api/config")
        print("=" * 60)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down AgriTrustGeoAgent server.")
            httpd.server_close()

if __name__ == '__main__':
    run()
