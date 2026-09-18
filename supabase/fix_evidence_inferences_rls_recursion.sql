-- ==============================================================================
-- AgriTrustGeoAgent - Fix for crop_evidence & diagnostic_inferences 42P17 RLS Recursion
-- ==============================================================================
-- Problem:
--   The policy "Agronomists can view evidence in escalations" on public.crop_evidence
--   queried public.diagnostic_inferences.
--   Meanwhile, the policy "Growers view own diagnostic inferences" on 
--   public.diagnostic_inferences queried public.crop_evidence back.
--   During query planning, PostgreSQL recursively evaluates RLS across both
--   relations, resulting in error 42P17 (infinite recursion detected).
--
-- Solution:
--   1. Introduce SECURITY DEFINER helper function `public.is_evidence_escalated(UUID)`
--      which queries diagnostic_inferences and escalation_tickets with bypassed RLS.
--   2. Introduce SECURITY DEFINER helper function `public.is_evidence_owner(UUID, UUID)`
--      which checks crop_evidence uploader ownership with bypassed RLS.
--   3. Both functions have pinned search_path ('public, extensions') to prevent
--      search_path hijacking vulnerabilities.
--   4. Recreate policies on public.crop_evidence using direct auth.uid() checks for
--      farmers and public.is_evidence_escalated(id) for agronomists.
--   5. Recreate policies on public.diagnostic_inferences using public.is_evidence_owner()
--      for growers and direct column checks for agronomists.
--   6. Farmer data isolation is 100% strictly enforced via auth.uid().
-- ==============================================================================

-- 1. Helper function: Evaluates if crop evidence is part of an active escalation
CREATE OR REPLACE FUNCTION public.is_evidence_escalated(p_evidence_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 
        FROM public.diagnostic_inferences di
        JOIN public.escalation_tickets et ON et.inference_id = di.id
        WHERE di.evidence_id = p_evidence_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, extensions;

-- Security Hardening: Revoke execute from PUBLIC and grant only to authenticated and service_role
REVOKE EXECUTE ON FUNCTION public.is_evidence_escalated(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_evidence_escalated(UUID) TO authenticated, service_role;

-- 2. Helper function: Evaluates evidence ownership without triggering RLS recursion
CREATE OR REPLACE FUNCTION public.is_evidence_owner(p_evidence_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 
        FROM public.crop_evidence
        WHERE id = p_evidence_id AND uploader_id = p_user_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, extensions;

-- Security Hardening: Revoke execute from PUBLIC and grant only to authenticated and service_role
REVOKE EXECUTE ON FUNCTION public.is_evidence_owner(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_evidence_owner(UUID, UUID) TO authenticated, service_role;

-- 3. Drop existing policies on public.crop_evidence
DROP POLICY IF EXISTS "Users have CRUD on their evidence" ON public.crop_evidence;
DROP POLICY IF EXISTS "Agronomists can view evidence in escalations" ON public.crop_evidence;

-- 4. Recreate Farmer Ownership Policy on public.crop_evidence (Direct, Zero-subquery, auth.uid() isolated)
CREATE POLICY "Users have CRUD on their evidence"
    ON public.crop_evidence FOR ALL
    TO authenticated
    USING (uploader_id = auth.uid())
    WITH CHECK (uploader_id = auth.uid());

-- 5. Recreate Agronomist Escalation View Policy on public.crop_evidence (Non-recursive via SECURITY DEFINER)
CREATE POLICY "Agronomists can view evidence in escalations"
    ON public.crop_evidence FOR SELECT
    TO authenticated
    USING (
        public.current_user_role() = 'agronomist' AND
        public.is_evidence_escalated(id)
    );

-- 6. Drop existing policies on public.diagnostic_inferences
DROP POLICY IF EXISTS "Growers view own diagnostic inferences" ON public.diagnostic_inferences;
DROP POLICY IF EXISTS "Agronomists view inferences needing review" ON public.diagnostic_inferences;

-- 7. Recreate Grower Ownership Policy on public.diagnostic_inferences (Non-recursive via SECURITY DEFINER)
CREATE POLICY "Growers view own diagnostic inferences"
    ON public.diagnostic_inferences FOR SELECT
    TO authenticated
    USING (public.is_evidence_owner(evidence_id, auth.uid()));

-- 8. Recreate Agronomist Review Policy on public.diagnostic_inferences (Direct attribute check, zero subqueries)
CREATE POLICY "Agronomists view inferences needing review"
    ON public.diagnostic_inferences FOR SELECT
    TO authenticated
    USING (
        public.current_user_role() = 'agronomist' AND
        requires_escalation = TRUE
    );

-- Verification Output
DO $$
BEGIN
    RAISE NOTICE 'AgriTrustGeoAgent RLS recursion remediation successfully applied.';
END $$;
