/**
 * Tests for Acta schema validators and state machine.
 *
 * Run: npx vitest
 */

import { describe, it, expect } from 'vitest';
import { validateContribution, validateResponse, computeState, TOKEN_COSTS } from '../src/validators/schema.js';

// ── Contribution Validation ─────────────────────────────────────────

describe('validateContribution', () => {
    // Questions
    it('accepts a valid question', () => {
        const result = validateContribution('question', { body: 'What is the capital of France?' });
        expect(result.valid).toBe(true);
    });

    it('rejects a question with empty body', () => {
        const result = validateContribution('question', { body: '' });
        expect(result.valid).toBe(false);
        expect(result.errors[0].field).toBe('body');
    });

    // Claims
    it('accepts a factual claim with source', () => {
        const result = validateContribution('claim', {
            body: 'The Earth orbits the Sun.',
            category: 'factual',
            source: 'https://nasa.gov/earth-orbit',
        });
        expect(result.valid).toBe(true);
    });

    it('accepts a factual claim with reasoning', () => {
        const result = validateContribution('claim', {
            body: 'The Earth orbits the Sun.',
            category: 'factual',
            reasoning: 'Observable planetary motion and gravitational models.',
        });
        expect(result.valid).toBe(true);
    });

    it('rejects a factual claim with no source or reasoning', () => {
        const result = validateContribution('claim', {
            body: 'The Earth orbits the Sun.',
            category: 'factual',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'source')).toBe(true);
    });

    it('accepts an opinion with uncertainty', () => {
        const result = validateContribution('claim', {
            body: 'I think decentralized systems are better.',
            category: 'opinion',
            uncertainty: 'High confidence but depends on the use case. Better for censorship resistance, worse for latency.',
        });
        expect(result.valid).toBe(true);
    });

    it('rejects an opinion without uncertainty', () => {
        const result = validateContribution('claim', {
            body: 'Decentralized is better.',
            category: 'opinion',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'uncertainty')).toBe(true);
    });

    it('rejects a claim with invalid category', () => {
        const result = validateContribution('claim', {
            body: 'Something.',
            category: 'rant',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'category')).toBe(true);
    });

    it('rejects a claim with body over 10000 chars', () => {
        const result = validateContribution('claim', {
            body: 'x'.repeat(10001),
            category: 'opinion',
            uncertainty: 'test',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'body')).toBe(true);
    });

    // Predictions
    it('accepts a valid prediction', () => {
        const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
        const result = validateContribution('prediction', {
            body: 'GPT-5 will be released by end of 2026.',
            resolution_criteria: 'OpenAI announces public availability of GPT-5.',
            resolution_date: futureDate,
            resolution_source: 'https://openai.com/blog',
        });
        expect(result.valid).toBe(true);
    });

    it('rejects a prediction without resolution criteria', () => {
        const result = validateContribution('prediction', {
            body: 'Something will happen.',
            resolution_date: new Date(Date.now() + 86400000).toISOString(),
            resolution_source: 'https://example.com',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'resolution_criteria')).toBe(true);
    });

    it('rejects a prediction with past resolution date', () => {
        const result = validateContribution('prediction', {
            body: 'Something happened.',
            resolution_criteria: 'It happened.',
            resolution_date: '2020-01-01T00:00:00Z',
            resolution_source: 'https://example.com',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'resolution_date')).toBe(true);
    });

    it('rejects an invalid type', () => {
        const result = validateContribution('rant', { body: 'Something' });
        expect(result.valid).toBe(false);
    });
});

// ── Response Validation ─────────────────────────────────────────────

describe('validateResponse', () => {
    // Evidence
    it('accepts valid evidence', () => {
        const result = validateResponse('evidence', {
            target_id: 'abc-123',
            body: 'Supporting evidence from NASA.',
            source: 'https://nasa.gov/data',
            stance: 'supporting',
        });
        expect(result.valid).toBe(true);
    });

    it('rejects evidence without source', () => {
        const result = validateResponse('evidence', {
            target_id: 'abc-123',
            body: 'Trust me.',
            stance: 'supporting',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'source')).toBe(true);
    });

    // Challenges — ASYMMETRIC FRICTION
    it('accepts a well-formed challenge', () => {
        const result = validateResponse('challenge', {
            target_id: 'abc-123',
            body: 'The source cited is unreliable because it was retracted.',
            target_assertion: 'The Earth orbits the Sun at constant speed',
            basis: 'source_unreliable',
            argument: 'The cited paper was retracted in 2024 due to data fabrication. See retraction notice.',
            source: 'https://retractionwatch.com/example',
        });
        expect(result.valid).toBe(true);
    });

    it('rejects a challenge without target_assertion (anti-DDoS)', () => {
        const result = validateResponse('challenge', {
            target_id: 'abc-123',
            body: 'I disagree.',
            basis: 'logical_error',
            argument: 'This is wrong for many reasons that I will now explain at length.',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'target_assertion')).toBe(true);
    });

    it('rejects a challenge with too-short argument', () => {
        const result = validateResponse('challenge', {
            target_id: 'abc-123',
            body: 'Wrong.',
            target_assertion: 'The claim about speed',
            basis: 'logical_error',
            argument: 'Wrong.',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'argument')).toBe(true);
    });

    it('rejects a challenge with counter_evidence basis but no source', () => {
        const result = validateResponse('challenge', {
            target_id: 'abc-123',
            body: 'Counter evidence exists.',
            target_assertion: 'The claim about temperature',
            basis: 'counter_evidence',
            argument: 'Multiple studies show the opposite temperature trend over the last decade.',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'source')).toBe(true);
    });

    // Resolution
    it('accepts a valid resolution', () => {
        const result = validateResponse('resolution', {
            target_id: 'abc-123',
            body: 'The prediction was confirmed.',
            outcome: 'GPT-5 was released on March 1, 2026.',
            source: 'https://openai.com/blog/gpt-5',
            resolution_type: 'confirmed',
        });
        expect(result.valid).toBe(true);
    });

    // Update
    it('accepts a valid update', () => {
        const result = validateResponse('update', {
            target_id: 'abc-123',
            body: 'New data available.',
            update_type: 'additional_context',
        });
        expect(result.valid).toBe(true);
    });
});

// ── State Machine ───────────────────────────────────────────────────

describe('computeState', () => {
    it('returns open for a new claim with no responses', () => {
        const claim = { entry_id: 'c1', subtype: 'claim', state: 'open' };
        const result = computeState(claim, []);
        expect(result.state).toBe('open');
    });

    it('returns contested when an unaddressed challenge exists', () => {
        const claim = { entry_id: 'c1', subtype: 'claim', state: 'open' };
        const responses = [
            { entry_id: 'ch1', subtype: 'challenge', target_id: 'c1' },
        ];
        const result = computeState(claim, responses);
        expect(result.state).toBe('contested');
    });

    it('returns open with supported hint when evidence exists and no challenges', () => {
        const claim = { entry_id: 'c1', subtype: 'claim', state: 'open' };
        const responses = [
            { entry_id: 'e1', subtype: 'evidence', target_id: 'c1', stance: 'supporting' },
        ];
        const result = computeState(claim, responses);
        expect(result.state).toBe('open');
        expect(result.display_hint).toBe('supported');
    });

    it('returns open when all challenges are addressed', () => {
        const claim = { entry_id: 'c1', subtype: 'claim', state: 'open' };
        const responses = [
            { entry_id: 'ch1', subtype: 'challenge', target_id: 'c1' },
            { entry_id: 'e1', subtype: 'evidence', target_id: 'ch1', stance: 'refuting' },
        ];
        const result = computeState(claim, responses);
        expect(result.state).toBe('open');
    });

    it('returns resolved for a question with a resolution', () => {
        const question = { entry_id: 'q1', subtype: 'question', state: 'open' };
        const responses = [
            { entry_id: 'r1', subtype: 'resolution', target_id: 'q1' },
        ];
        const result = computeState(question, responses);
        expect(result.state).toBe('resolved');
    });

    it('returns open when a resolution is challenged', () => {
        const question = { entry_id: 'q1', subtype: 'question', state: 'open' };
        const responses = [
            { entry_id: 'r1', subtype: 'resolution', target_id: 'q1' },
            { entry_id: 'ch1', subtype: 'challenge', target_id: 'r1' },
        ];
        const result = computeState(question, responses);
        expect(result.state).toBe('open');
    });

    it('returns resolved_confirmed for prediction with confirmed resolution', () => {
        const prediction = { entry_id: 'p1', subtype: 'prediction', state: 'open', payload: {} };
        const responses = [
            { entry_id: 'r1', subtype: 'resolution', target_id: 'p1', payload: { resolution_type: 'confirmed' } },
        ];
        const result = computeState(prediction, responses);
        expect(result.state).toBe('resolved_confirmed');
    });
});

// ── Token Costs ─────────────────────────────────────────────────────

describe('TOKEN_COSTS', () => {
    it('charges 2 tokens for contributions', () => {
        expect(TOKEN_COSTS.question).toBe(2);
        expect(TOKEN_COSTS.claim).toBe(2);
        expect(TOKEN_COSTS.prediction).toBe(2);
    });

    it('charges 1 token for standard responses', () => {
        expect(TOKEN_COSTS.evidence).toBe(1);
        expect(TOKEN_COSTS.update).toBe(1);
        expect(TOKEN_COSTS.resolution).toBe(1);
    });

    it('charges 2 tokens for challenges (asymmetric friction)', () => {
        expect(TOKEN_COSTS.challenge).toBe(2);
    });
});
