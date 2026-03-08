/**
 * Schema validators for Acta typed contributions and responses.
 *
 * These are pure functions — deterministic, no LLM, no external calls.
 * They implement Tier 1 enforcement from the Protocol Spec.
 */

// ── Contribution Types ──────────────────────────────────────────────

const CONTRIBUTION_TYPES = ['question', 'claim', 'prediction'];
const RESPONSE_TYPES = ['evidence', 'challenge', 'update', 'resolution'];
const CLAIM_CATEGORIES = ['factual', 'opinion', 'hypothesis'];
const CHALLENGE_BASES = ['counter_evidence', 'logical_error', 'source_unreliable', 'missing_context'];
const EVIDENCE_STANCES = ['supporting', 'refuting', 'contextual'];
const UPDATE_TYPES = ['correction', 'additional_context', 'scope_change', 'alternative_source'];
const RESOLUTION_TYPES = ['answered', 'confirmed', 'refuted', 'partially_confirmed', 'unresolvable'];

// ── Token costs per action ──────────────────────────────────────────

export const TOKEN_COSTS = {
    question: 2,
    claim: 2,
    prediction: 2,
    evidence: 1,
    challenge: 2,  // Asymmetric friction — challenges cost more than standard responses
    update: 1,
    resolution: 1,
};

// ── Contribution Validators ─────────────────────────────────────────

export function validateContribution(type, payload) {
    const errors = [];

    if (!CONTRIBUTION_TYPES.includes(type)) {
        return { valid: false, errors: [{ field: 'type', error: `Must be one of: ${CONTRIBUTION_TYPES.join(', ')}` }] };
    }

    // Common: body is always required
    if (!payload.body || typeof payload.body !== 'string' || payload.body.trim().length < 1) {
        errors.push({ field: 'body', error: 'Required, must be a non-empty string' });
    }

    if (payload.body && payload.body.length > 10000) {
        errors.push({ field: 'body', error: 'Maximum 10,000 characters' });
    }

    switch (type) {
        case 'claim':
            errors.push(...validateClaim(payload));
            break;
        case 'prediction':
            errors.push(...validatePrediction(payload));
            break;
        case 'question':
            // No additional burden — questions are free
            break;
    }

    return errors.length ? { valid: false, errors } : { valid: true };
}

function validateClaim(payload) {
    const errors = [];

    if (!CLAIM_CATEGORIES.includes(payload.category)) {
        errors.push({
            field: 'category',
            error: `Required. Must be one of: ${CLAIM_CATEGORIES.join(', ')}`,
        });
    }

    // Factual claims have an evidence burden
    if (payload.category === 'factual') {
        if (!payload.source && !payload.reasoning) {
            errors.push({
                field: 'source',
                error: 'Factual claims require a source (URL/DOI/reference) or reasoning. Add one, or change category to opinion or hypothesis.',
            });
        }
    }

    // Opinion/hypothesis require explicit uncertainty
    if ((payload.category === 'opinion' || payload.category === 'hypothesis') && !payload.uncertainty) {
        errors.push({
            field: 'uncertainty',
            error: `${payload.category} contributions require an explicit uncertainty statement (confidence level, limitations, what would change your mind).`,
        });
    }

    return errors;
}

function validatePrediction(payload) {
    const errors = [];

    if (!payload.resolution_criteria || typeof payload.resolution_criteria !== 'string') {
        errors.push({ field: 'resolution_criteria', error: 'Required. Must describe how to determine if the prediction is confirmed or refuted.' });
    }

    if (!payload.resolution_date) {
        errors.push({ field: 'resolution_date', error: 'Required. ISO-8601 date.' });
    } else {
        const parsed = Date.parse(payload.resolution_date);
        if (isNaN(parsed)) {
            errors.push({ field: 'resolution_date', error: 'Must be a valid ISO-8601 date.' });
        } else if (parsed <= Date.now()) {
            errors.push({ field: 'resolution_date', error: 'Must be in the future.' });
        }
    }

    if (!payload.resolution_source || typeof payload.resolution_source !== 'string') {
        errors.push({ field: 'resolution_source', error: 'Required. URL or reference to the authoritative source for resolution.' });
    }

    return errors;
}

// ── Response Validators ─────────────────────────────────────────────

export function validateResponse(type, payload) {
    const errors = [];

    if (!RESPONSE_TYPES.includes(type)) {
        return { valid: false, errors: [{ field: 'type', error: `Must be one of: ${RESPONSE_TYPES.join(', ')}` }] };
    }

    // Common: target_id is always required for responses
    if (!payload.target_id || typeof payload.target_id !== 'string') {
        errors.push({ field: 'target_id', error: 'Required. Must reference the contribution this responds to.' });
    }

    // Common: body
    if (!payload.body || typeof payload.body !== 'string' || payload.body.trim().length < 1) {
        errors.push({ field: 'body', error: 'Required, must be a non-empty string' });
    }

    if (payload.body && payload.body.length > 10000) {
        errors.push({ field: 'body', error: 'Maximum 10,000 characters' });
    }

    switch (type) {
        case 'evidence':
            errors.push(...validateEvidence(payload));
            break;
        case 'challenge':
            errors.push(...validateChallenge(payload));
            break;
        case 'update':
            errors.push(...validateUpdate(payload));
            break;
        case 'resolution':
            errors.push(...validateResolution(payload));
            break;
    }

    return errors.length ? { valid: false, errors } : { valid: true };
}

function validateEvidence(payload) {
    const errors = [];

    if (!payload.source || typeof payload.source !== 'string') {
        errors.push({ field: 'source', error: 'Required. Verifiable reference (URL, DOI, public record).' });
    }

    if (!EVIDENCE_STANCES.includes(payload.stance)) {
        errors.push({ field: 'stance', error: `Required. Must be one of: ${EVIDENCE_STANCES.join(', ')}` });
    }

    return errors;
}

/**
 * Challenge validation — ASYMMETRIC FRICTION.
 * Challenges have stricter requirements than other responses to prevent
 * semantic DDoS (Brandolini's Law countermeasure).
 */
function validateChallenge(payload) {
    const errors = [];

    if (!payload.target_assertion || typeof payload.target_assertion !== 'string' || payload.target_assertion.trim().length < 5) {
        errors.push({
            field: 'target_assertion',
            error: 'Required. Must quote or reference the specific assertion being challenged (min 5 chars).',
        });
    }

    if (!CHALLENGE_BASES.includes(payload.basis)) {
        errors.push({
            field: 'basis',
            error: `Required. Must be one of: ${CHALLENGE_BASES.join(', ')}`,
        });
    }

    if (!payload.argument || typeof payload.argument !== 'string' || payload.argument.trim().length < 20) {
        errors.push({
            field: 'argument',
            error: 'Required. Substantive refutation (min 20 chars). Must include counter-evidence, identification of a specific logical error, or demonstration of source unreliability.',
        });
    }

    // Source required for certain basis types
    if (['counter_evidence', 'source_unreliable'].includes(payload.basis) && !payload.source) {
        errors.push({
            field: 'source',
            error: `Source required when basis is ${payload.basis}.`,
        });
    }

    return errors;
}

function validateUpdate(payload) {
    const errors = [];

    if (!UPDATE_TYPES.includes(payload.update_type)) {
        errors.push({ field: 'update_type', error: `Required. Must be one of: ${UPDATE_TYPES.join(', ')}` });
    }

    return errors;
}

function validateResolution(payload) {
    const errors = [];

    if (!payload.outcome || typeof payload.outcome !== 'string') {
        errors.push({ field: 'outcome', error: 'Required. The resolution outcome.' });
    }

    if (!payload.source || typeof payload.source !== 'string') {
        errors.push({ field: 'source', error: 'Required. Evidence of resolution.' });
    }

    if (!RESOLUTION_TYPES.includes(payload.resolution_type)) {
        errors.push({ field: 'resolution_type', error: `Required. Must be one of: ${RESOLUTION_TYPES.join(', ')}` });
    }

    return errors;
}

// ── State Machine ───────────────────────────────────────────────────

/**
 * Compute the current state of a contribution based on its responses.
 * "supported" is a DISPLAY HINT, not an official state transition.
 * The protocol shows evidence structure — it never declares truth.
 */
export function computeState(contribution, responses) {
    const type = contribution.subtype;

    switch (type) {
        case 'question':
            return computeQuestionState(contribution, responses);
        case 'claim':
            return computeClaimState(contribution, responses);
        case 'prediction':
            return computePredictionState(contribution, responses);
        default:
            return { state: contribution.state || 'open', display_hint: null };
    }
}

function computeQuestionState(question, responses) {
    // Check for resolution
    const resolutions = responses.filter(r => r.subtype === 'resolution');
    if (resolutions.length > 0) {
        // Check if any resolution has been challenged
        const lastResolution = resolutions[resolutions.length - 1];
        const resolutionChallenged = responses.some(
            r => r.subtype === 'challenge' && r.target_id === lastResolution.entry_id
        );
        if (!resolutionChallenged) {
            return { state: 'resolved', display_hint: null };
        }
    }

    if (question.state === 'closed') {
        return { state: 'closed', display_hint: null };
    }

    return { state: 'open', display_hint: null };
}

function computeClaimState(claim, responses) {
    // Check for supersession
    const superseded = responses.some(
        r => r.subtype === 'update' && r.payload?.update_type === 'scope_change'
    );
    if (superseded) {
        return { state: 'superseded', display_hint: null };
    }

    // Get all challenges against the claim itself
    const challenges = responses.filter(
        r => r.subtype === 'challenge' && r.target_id === claim.entry_id
    );

    // Check which challenges have been addressed
    const unaddressedChallenges = challenges.filter(challenge => {
        const counterResponses = responses.filter(
            r => r.target_id === challenge.entry_id &&
                (r.subtype === 'evidence' || r.subtype === 'update')
        );
        // A challenge is addressed if it has at least one counter-response
        // that itself hasn't been successfully challenged
        return counterResponses.length === 0;
    });

    if (unaddressedChallenges.length > 0) {
        return { state: 'contested', display_hint: null };
    }

    // Check if claim started as unsubstantiated and now has evidence
    if (claim.state === 'unsubstantiated') {
        const supportingEvidence = responses.filter(
            r => r.subtype === 'evidence' && r.stance === 'supporting'
        );
        if (supportingEvidence.length === 0) {
            return { state: 'unsubstantiated', display_hint: null };
        }
    }

    // Compute display hint
    const supportingEvidence = responses.filter(
        r => r.subtype === 'evidence' && r.stance === 'supporting'
    );
    const displayHint = supportingEvidence.length > 0 && challenges.length === 0
        ? 'supported'
        : null;

    return { state: 'open', display_hint: displayHint };
}

function computePredictionState(prediction, responses) {
    const resolutions = responses.filter(r => r.subtype === 'resolution');
    if (resolutions.length > 0) {
        const lastResolution = resolutions[resolutions.length - 1];

        // Check if resolution has been challenged
        const resolutionChallenged = responses.some(
            r => r.subtype === 'challenge' && r.target_id === lastResolution.entry_id
        );

        if (resolutionChallenged) {
            return { state: 'contested', display_hint: null };
        }

        // Map resolution_type to state
        const stateMap = {
            confirmed: 'resolved_confirmed',
            refuted: 'resolved_refuted',
            partially_confirmed: 'resolved_confirmed',
            unresolvable: 'unresolvable',
        };

        return {
            state: stateMap[lastResolution.payload?.resolution_type] || 'resolved_confirmed',
            display_hint: null,
        };
    }

    // Check if past resolution date
    if (prediction.payload?.resolution_date) {
        const resolutionDate = new Date(prediction.payload.resolution_date);
        if (resolutionDate <= new Date()) {
            return { state: 'open', display_hint: 'awaiting_resolution' };
        }
    }

    return { state: 'open', display_hint: null };
}
