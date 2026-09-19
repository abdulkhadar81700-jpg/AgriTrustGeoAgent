-- ==============================================================================
-- AgriTrustGeoAgent - Complete Production Database Migration
-- Target: Supabase PostgreSQL 16+ with PostGIS installed in 'postgis' schema
-- Ready to execute directly in Supabase SQL Editor
-- Security: Strict Search Paths, Zero-Recursion RLS, Idempotent DDL
-- ==============================================================================

-- 1. EXTENSIONS & SCHEMAS
-- Note: PostGIS is pre-installed in the 'postgis' schema. We do NOT recreate or relocate it.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Set search_path for this migration session so PostGIS operators and types resolve
SET search_path TO public, postgis, extensions;

-- Permanently configure search_path on database so PostgREST and all client roles resolve PostGIS
ALTER DATABASE postgres SET search_path TO public, postgis, extensions;

-- Ensure application roles inherit or explicitly use the postgis search path
DO $$
BEGIN
    EXECUTE 'ALTER ROLE anon SET search_path TO public, postgis, extensions';
    EXECUTE 'ALTER ROLE authenticated SET search_path TO public, postgis, extensions';
    EXECUTE 'ALTER ROLE service_role SET search_path TO public, postgis, extensions';
EXCEPTION WHEN OTHERS THEN
    -- Silently continue if role-level alteration is restricted
    NULL;
END $$;

-- Grant usage and permissions on postgis schema to Supabase application roles
GRANT USAGE ON SCHEMA postgis TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA postgis TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA postgis TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA postgis TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA postgis GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA postgis GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;

-- ==============================================================================
-- 2. CORE DOMAIN TABLES
-- ==============================================================================

-- TABLE: profiles (Extends auth.users with agricultural roles & metadata)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('farmer', 'agronomist', 'enterprise_admin')),
    full_name TEXT NOT NULL,
    organization_name TEXT,
    phone_number TEXT,
    data_sovereignty_agreed BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- TABLE: fields (Farm parcel boundaries with PostGIS polygons in postgis schema)
CREATE TABLE IF NOT EXISTS public.fields (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    crop_variety TEXT NOT NULL,
    planting_date DATE,
    acreage NUMERIC(10, 2) NOT NULL,
    boundary postgis.geometry(Polygon, 4326) NOT NULL,
    centroid postgis.geometry(Point, 4326),
    soil_texture_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PostGIS Spatial & Performance Indexes for fields
CREATE INDEX IF NOT EXISTS idx_fields_boundary ON public.fields USING GIST (boundary);
CREATE INDEX IF NOT EXISTS idx_fields_centroid ON public.fields USING GIST (centroid);
CREATE INDEX IF NOT EXISTS idx_fields_farmer ON public.fields (farmer_id);

-- TABLE: crop_evidence (Leaf/field camera captures with validation gate)
CREATE TABLE IF NOT EXISTS public.crop_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    field_id UUID REFERENCES public.fields(id) ON DELETE SET NULL,
    uploader_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    capture_location postgis.geometry(Point, 4326) NOT NULL,
    capture_timestamp TIMESTAMPTZ NOT NULL,
    blur_laplacian_var NUMERIC(10, 4),
    is_geofence_verified BOOLEAN NOT NULL DEFAULT FALSE,
    validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'passed', 'rejected')),
    rejection_reasons TEXT[] DEFAULT '{}',
    optical_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PostGIS Spatial & Query Indexes for crop_evidence
CREATE INDEX IF NOT EXISTS idx_evidence_location ON public.crop_evidence USING GIST (capture_location);
CREATE INDEX IF NOT EXISTS idx_evidence_field ON public.crop_evidence (field_id);
CREATE INDEX IF NOT EXISTS idx_evidence_uploader ON public.crop_evidence (uploader_id);
CREATE INDEX IF NOT EXISTS idx_evidence_status ON public.crop_evidence (validation_status);

-- TABLE: weather_telemetry (Hyperlocal environmental dynamics)
CREATE TABLE IF NOT EXISTS public.weather_telemetry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    field_id UUID NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
    observation_time TIMESTAMPTZ NOT NULL,
    temp_celsius NUMERIC(5, 2) NOT NULL,
    relative_humidity_pct NUMERIC(5, 2) NOT NULL,
    precipitation_mm NUMERIC(6, 2) NOT NULL,
    dew_point_c NUMERIC(5, 2),
    leaf_wetness_minutes INTEGER DEFAULT 0,
    cumulative_gdd NUMERIC(8, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_weather_field_time ON public.weather_telemetry (field_id, observation_time DESC);

-- TABLE: soil_telemetry (Volumetric root-zone moisture & chemistry)
CREATE TABLE IF NOT EXISTS public.soil_telemetry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    field_id UUID NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
    sampled_at TIMESTAMPTZ NOT NULL,
    moisture_depth_10cm NUMERIC(5, 2),
    moisture_depth_30cm NUMERIC(5, 2),
    soil_temp_c NUMERIC(5, 2),
    ec_ds_m NUMERIC(6, 3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_soil_field_time ON public.soil_telemetry (field_id, sampled_at DESC);

-- TABLE: satellite_indices (Multi-spectral canopy vigor metrics)
CREATE TABLE IF NOT EXISTS public.satellite_indices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    field_id UUID NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
    acquisition_date DATE NOT NULL,
    satellite_platform TEXT NOT NULL,
    mean_ndvi NUMERIC(5, 4) NOT NULL,
    mean_ndre NUMERIC(5, 4),
    mean_evi NUMERIC(5, 4),
    cloud_coverage_pct NUMERIC(5, 2) NOT NULL,
    tile_storage_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_satellite_field_date ON public.satellite_indices (field_id, acquisition_date DESC);

-- TABLE: diagnostic_inferences (Multi-modal AI inference with calibrated confidence)
CREATE TABLE IF NOT EXISTS public.diagnostic_inferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL UNIQUE REFERENCES public.crop_evidence(id) ON DELETE CASCADE,
    model_version TEXT NOT NULL,
    diagnosis_label TEXT NOT NULL,
    confidence_score NUMERIC(5, 4) NOT NULL CHECK (confidence_score >= 0.0 AND confidence_score < 1.0),
    uncertainty_margin NUMERIC(5, 4) NOT NULL,
    telemetry_context JSONB NOT NULL DEFAULT '{}'::jsonb,
    recommendation_text TEXT NOT NULL,
    requires_escalation BOOLEAN GENERATED ALWAYS AS (confidence_score < 0.85) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inferences_evidence ON public.diagnostic_inferences (evidence_id);
CREATE INDEX IF NOT EXISTS idx_inferences_escalation ON public.diagnostic_inferences (requires_escalation);

-- TABLE: escalation_tickets (Human-in-the-Loop Agronomist Triage Desk)
CREATE TABLE IF NOT EXISTS public.escalation_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inference_id UUID NOT NULL UNIQUE REFERENCES public.diagnostic_inferences(id) ON DELETE CASCADE,
    field_id UUID NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'under_review', 'resolved', 'rejected')),
    assigned_agronomist UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    priority TEXT NOT NULL DEFAULT 'standard' CHECK (priority IN ('standard', 'high', 'critical')),
    trigger_reason TEXT NOT NULL,
    agronomist_verdict TEXT,
    agronomist_prescription TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escalations_status ON public.escalation_tickets (status, priority);
CREATE INDEX IF NOT EXISTS idx_escalations_agronomist ON public.escalation_tickets (assigned_agronomist);
CREATE INDEX IF NOT EXISTS idx_escalations_field ON public.escalation_tickets (field_id);

-- ==============================================================================
-- 3. AUTOMATED FUNCTIONS & TRIGGERS (SECURED WITH EXPLICIT SEARCH PATH)
-- ==============================================================================

-- A. Auto-compute Field Centroid Trigger using postgis.ST_Centroid
CREATE OR REPLACE FUNCTION public.compute_field_centroid()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.boundary IS NOT NULL THEN
        NEW.centroid := postgis.ST_Centroid(NEW.boundary);
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, postgis, extensions;

DROP TRIGGER IF EXISTS trg_compute_field_centroid ON public.fields;
CREATE TRIGGER trg_compute_field_centroid
    BEFORE INSERT OR UPDATE OF boundary ON public.fields
    FOR EACH ROW EXECUTE FUNCTION public.compute_field_centroid();

-- B. Auto-create Profile on Supabase Auth Signup (Hardened)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (
        id,
        role,
        full_name,
        organization_name,
        phone_number
    ) VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'role', 'farmer'),
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        NEW.raw_user_meta_data->>'organization_name',
        NEW.raw_user_meta_data->>'phone'
    )
    ON CONFLICT (id) DO UPDATE SET
        role = EXCLUDED.role,
        full_name = EXCLUDED.full_name,
        organization_name = EXCLUDED.organization_name,
        phone_number = EXCLUDED.phone_number,
        updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, postgis, extensions;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- C. Automated PostGIS Geofence Verification for Crop Evidence using postgis.ST_Contains
CREATE OR REPLACE FUNCTION public.verify_evidence_geofence()
RETURNS TRIGGER AS $$
DECLARE
    matched_field_id UUID;
BEGIN
    NEW.rejection_reasons := COALESCE(NEW.rejection_reasons, '{}');

    IF NEW.capture_location IS NOT NULL THEN
        -- Query farmer's fields with postgis.ST_Contains
        SELECT id INTO matched_field_id
        FROM public.fields
        WHERE farmer_id = NEW.uploader_id
          AND postgis.ST_Contains(boundary, NEW.capture_location)
        LIMIT 1;

        IF matched_field_id IS NOT NULL THEN
            NEW.field_id := matched_field_id;
            NEW.is_geofence_verified := TRUE;
        ELSE
            NEW.is_geofence_verified := FALSE;
            IF NOT ('OUTSIDE_REGISTERED_BOUNDARY' = ANY(NEW.rejection_reasons)) THEN
                NEW.rejection_reasons := array_append(NEW.rejection_reasons, 'OUTSIDE_REGISTERED_BOUNDARY');
            END IF;
        END IF;
    ELSE
        NEW.is_geofence_verified := FALSE;
        IF NOT ('NO_COORDINATES' = ANY(NEW.rejection_reasons)) THEN
            NEW.rejection_reasons := array_append(NEW.rejection_reasons, 'NO_COORDINATES');
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, postgis, extensions;

DROP TRIGGER IF EXISTS trg_verify_evidence_geofence ON public.crop_evidence;
CREATE TRIGGER trg_verify_evidence_geofence
    BEFORE INSERT ON public.crop_evidence
    FOR EACH ROW EXECUTE FUNCTION public.verify_evidence_geofence();

-- D. Automated Agronomist Escalation Trigger on Low Confidence (SECURITY DEFINER to avoid RLS block)
CREATE OR REPLACE FUNCTION public.auto_create_escalation_ticket()
RETURNS TRIGGER AS $$
DECLARE
    v_field_id UUID;
BEGIN
    IF NEW.requires_escalation THEN
        SELECT field_id INTO v_field_id 
        FROM public.crop_evidence 
        WHERE id = NEW.evidence_id;

        IF v_field_id IS NOT NULL THEN
            INSERT INTO public.escalation_tickets (
                inference_id,
                field_id,
                status,
                priority,
                trigger_reason
            ) VALUES (
                NEW.id,
                v_field_id,
                'queued',
                CASE 
                    WHEN NEW.confidence_score < 0.60 THEN 'critical' 
                    ELSE 'high' 
                END,
                'CONFIDENCE_BELOW_SAFETY_THRESHOLD'
            )
            ON CONFLICT (inference_id) DO NOTHING;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, postgis, extensions;

DROP TRIGGER IF EXISTS trg_auto_create_escalation ON public.diagnostic_inferences;
CREATE TRIGGER trg_auto_create_escalation
    AFTER INSERT ON public.diagnostic_inferences
    FOR EACH ROW EXECUTE FUNCTION public.auto_create_escalation_ticket();

-- ==============================================================================
-- 4. ROW LEVEL SECURITY (RLS) POLICIES (IDEMPOTENT & ZERO-RECURSION)
-- ==============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crop_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weather_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.soil_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.satellite_indices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diagnostic_inferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escalation_tickets ENABLE ROW LEVEL SECURITY;

-- Helper function: Reads role directly from auth JWT token (Eliminates table recursion)
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT AS $$
    SELECT COALESCE(
        auth.jwt() -> 'user_metadata' ->> 'role',
        auth.jwt() -> 'app_metadata' ->> 'role',
        'farmer'
    );
$$ LANGUAGE sql STABLE;

-- 1. PROFILES POLICIES
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

DROP POLICY IF EXISTS "Agronomists can view client profiles" ON public.profiles;
CREATE POLICY "Agronomists can view client profiles"
    ON public.profiles FOR SELECT
    USING (public.current_user_role() = 'agronomist');

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- 2. FIELDS POLICIES
-- Helper function: Evaluates escalation presence without triggering cross-table RLS recursion
CREATE OR REPLACE FUNCTION public.is_field_escalated(p_field_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.escalation_tickets
        WHERE field_id = p_field_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, extensions;

REVOKE EXECUTE ON FUNCTION public.is_field_escalated(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_field_escalated(UUID) TO authenticated, service_role;

DROP POLICY IF EXISTS "Farmers have full CRUD on their fields" ON public.fields;
CREATE POLICY "Farmers have full CRUD on their fields"
    ON public.fields FOR ALL
    USING (farmer_id = auth.uid())
    WITH CHECK (farmer_id = auth.uid());

DROP POLICY IF EXISTS "Agronomists can view escalated fields" ON public.fields;
CREATE POLICY "Agronomists can view escalated fields"
    ON public.fields FOR SELECT
    USING (
        public.current_user_role() = 'agronomist' AND
        public.is_field_escalated(id)
    );

-- 3. CROP EVIDENCE POLICIES
-- Helper function: Evaluates if crop evidence is part of an active escalation without RLS recursion
CREATE OR REPLACE FUNCTION public.is_evidence_escalated(p_evidence_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 
        FROM public.diagnostic_inferences di
        JOIN public.escalation_tickets et ON et.inference_id = di.id
        WHERE di.evidence_id = p_evidence_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, extensions;

REVOKE EXECUTE ON FUNCTION public.is_evidence_escalated(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_evidence_escalated(UUID) TO authenticated, service_role;

DROP POLICY IF EXISTS "Users have CRUD on their evidence" ON public.crop_evidence;
CREATE POLICY "Users have CRUD on their evidence"
    ON public.crop_evidence FOR ALL
    TO authenticated
    USING (uploader_id = auth.uid())
    WITH CHECK (uploader_id = auth.uid());

DROP POLICY IF EXISTS "Agronomists can view evidence in escalations" ON public.crop_evidence;
CREATE POLICY "Agronomists can view evidence in escalations"
    ON public.crop_evidence FOR SELECT
    TO authenticated
    USING (
        public.current_user_role() = 'agronomist' AND
        public.is_evidence_escalated(id)
    );

-- 4. TELEMETRY POLICIES (Weather, Soil, Satellite)
DROP POLICY IF EXISTS "Growers view own weather telemetry" ON public.weather_telemetry;
CREATE POLICY "Growers view own weather telemetry"
    ON public.weather_telemetry FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.fields 
            WHERE fields.id = weather_telemetry.field_id AND fields.farmer_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Growers view own soil telemetry" ON public.soil_telemetry;
CREATE POLICY "Growers view own soil telemetry"
    ON public.soil_telemetry FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.fields 
            WHERE fields.id = soil_telemetry.field_id AND fields.farmer_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Growers view own satellite indices" ON public.satellite_indices;
CREATE POLICY "Growers view own satellite indices"
    ON public.satellite_indices FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.fields 
            WHERE fields.id = satellite_indices.field_id AND fields.farmer_id = auth.uid()
        )
    );

-- 5. DIAGNOSTIC INFERENCES POLICIES
-- Helper function: Evaluates evidence ownership without triggering RLS recursion
CREATE OR REPLACE FUNCTION public.is_evidence_owner(p_evidence_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 
        FROM public.crop_evidence
        WHERE id = p_evidence_id AND uploader_id = p_user_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, extensions;

REVOKE EXECUTE ON FUNCTION public.is_evidence_owner(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_evidence_owner(UUID, UUID) TO authenticated, service_role;

DROP POLICY IF EXISTS "Growers view own diagnostic inferences" ON public.diagnostic_inferences;
CREATE POLICY "Growers view own diagnostic inferences"
    ON public.diagnostic_inferences FOR SELECT
    TO authenticated
    USING (public.is_evidence_owner(evidence_id, auth.uid()));

DROP POLICY IF EXISTS "Agronomists view inferences needing review" ON public.diagnostic_inferences;
CREATE POLICY "Agronomists view inferences needing review"
    ON public.diagnostic_inferences FOR SELECT
    TO authenticated
    USING (
        public.current_user_role() = 'agronomist' AND
        requires_escalation = TRUE
    );

-- 6. ESCALATION TICKETS POLICIES
DROP POLICY IF EXISTS "Farmers view tickets for their fields" ON public.escalation_tickets;
CREATE POLICY "Farmers view tickets for their fields"
    ON public.escalation_tickets FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.fields 
            WHERE fields.id = escalation_tickets.field_id AND fields.farmer_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Agronomists view and manage escalation tickets" ON public.escalation_tickets;
CREATE POLICY "Agronomists view and manage escalation tickets"
    ON public.escalation_tickets FOR ALL
    USING (public.current_user_role() = 'agronomist')
    WITH CHECK (public.current_user_role() = 'agronomist');

-- ==============================================================================
-- 5. STORAGE BUCKETS SETUP (crop-evidence & satellite-rasters)
-- ==============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
    ('crop-evidence', 'crop-evidence', FALSE, 20971520, ARRAY['image/jpeg', 'image/png', 'image/webp']),
    ('satellite-rasters', 'satellite-rasters', FALSE, 104857600, ARRAY['image/png', 'image/tiff', 'image/geotiff', 'application/json'])
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage RLS: Users can upload into their own folder (auth.uid())
DROP POLICY IF EXISTS "Users can upload evidence into their folder" ON storage.objects;
CREATE POLICY "Users can upload evidence into their folder"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'crop-evidence' AND
        (storage.foldername(name))[1] = auth.uid()::text
    );

DROP POLICY IF EXISTS "Users can read own evidence" ON storage.objects;
CREATE POLICY "Users can read own evidence"
    ON storage.objects FOR SELECT
    USING (
        bucket_id = 'crop-evidence' AND
        (storage.foldername(name))[1] = auth.uid()::text
    );

DROP POLICY IF EXISTS "Agronomists can view evidence photos" ON storage.objects;
CREATE POLICY "Agronomists can view evidence photos"
    ON storage.objects FOR SELECT
    USING (
        bucket_id = 'crop-evidence' AND
        public.current_user_role() = 'agronomist'
    );
