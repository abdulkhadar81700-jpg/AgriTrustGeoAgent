-- ==============================================================================
-- AgriTrustGeoAgent - Fix for public.fields RLS 42P17 Infinite Recursion
-- ==============================================================================
-- Problem:
--   The policy "Agronomists can view escalated fields" on public.fields queried
--   public.escalation_tickets via EXISTS (SELECT 1 FROM public.escalation_tickets...).
--   Meanwhile, public.escalation_tickets had a policy querying public.fields back.
--   PostgreSQL detected mutual cross-table RLS recursion and returned error 42P17.
--
-- Solution:
--   1. Introduce a SECURITY DEFINER helper function `public.is_field_escalated(UUID)`
--      with a fixed search_path to prevent search_path hijacking.
--   2. Explicitly revoke EXECUTE from PUBLIC, then grant EXECUTE only to
--      authenticated users and service_role.
--   3. Queries inside this SECURITY DEFINER function bypass RLS on escalation_tickets,
--      completely severing the circular recursion loop.
--   4. Keep the farmer policy direct and non-recursive (`farmer_id = auth.uid()`).
--   5. Replace the agronomist policy on public.fields to use `public.is_field_escalated(id)`.
-- ==============================================================================

-- 1. Helper function: Checks if a field has active escalations without triggering RLS recursion
CREATE OR REPLACE FUNCTION public.is_field_escalated(p_field_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.escalation_tickets
        WHERE field_id = p_field_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, extensions;

-- Security Hardening: Revoke execute from PUBLIC and grant only to trusted roles
REVOKE EXECUTE ON FUNCTION public.is_field_escalated(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_field_escalated(UUID) TO authenticated, service_role;

-- 2. Drop the existing recursive policies on public.fields
DROP POLICY IF EXISTS "Farmers have full CRUD on their fields" ON public.fields;
DROP POLICY IF EXISTS "Agronomists can view escalated fields" ON public.fields;

-- 3. Recreate Farmer Ownership Policy (Direct column check, 100% non-recursive)
CREATE POLICY "Farmers have full CRUD on their fields"
    ON public.fields FOR ALL
    TO authenticated
    USING (farmer_id = auth.uid())
    WITH CHECK (farmer_id = auth.uid());

-- 4. Recreate Agronomist Escalation View Policy (Non-recursive via SECURITY DEFINER)
CREATE POLICY "Agronomists can view escalated fields"
    ON public.fields FOR SELECT
    TO authenticated
    USING (
        public.current_user_role() = 'agronomist' AND
        public.is_field_escalated(id)
    );
