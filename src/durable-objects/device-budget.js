/**
 * DeviceBudget Durable Object
 *
 * Manages per-device token budgets for rate limiting.
 * One DO instance per device attestation hash.
 *
 * Token costs (from Policy):
 *   New contribution: 2 tokens
 *   Response: 1 token
 *   Challenge: 2 tokens
 *
 * Budget resets at midnight UTC daily.
 *
 * Storage layout:
 *   budget → { tokens: N, last_reset: ISO-8601, author_type: "human"|"agent" }
 */
export class DeviceBudget {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }

    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === 'POST' && url.pathname === '/spend') {
            return this.handleSpend(request);
        }

        if (request.method === 'GET' && url.pathname === '/balance') {
            return this.handleBalance();
        }

        return new Response('Not found', { status: 404 });
    }

    /**
     * Attempt to spend tokens. Returns success/failure and remaining balance.
     */
    async handleSpend(request) {
        const { cost, author_type } = await request.json();

        const budget = await this.getOrResetBudget(author_type || 'human');

        if (budget.tokens < cost) {
            return Response.json({
                allowed: false,
                tokens_remaining: budget.tokens,
                tokens_requested: cost,
                resets_at: this.nextResetTime(),
            }, { status: 429 });
        }

        budget.tokens -= cost;
        await this.state.storage.put('budget', budget);

        return Response.json({
            allowed: true,
            tokens_remaining: budget.tokens,
            tokens_spent: cost,
            resets_at: this.nextResetTime(),
        });
    }

    /**
     * Check current balance without spending.
     */
    async handleBalance() {
        const budget = await this.getOrResetBudget('human');

        return Response.json({
            tokens_remaining: budget.tokens,
            author_type: budget.author_type,
            last_reset: budget.last_reset,
            resets_at: this.nextResetTime(),
        });
    }

    /**
     * Get current budget, resetting if a new UTC day has started.
     */
    async getOrResetBudget(authorType) {
        const budget = await this.state.storage.get('budget');
        const today = new Date().toISOString().split('T')[0];

        // Budget limits from Policy v1
        const MAX_TOKENS = {
            human: 10,
            agent: 4,
        };

        if (!budget || budget.last_reset !== today) {
            const newBudget = {
                tokens: MAX_TOKENS[authorType] || MAX_TOKENS.human,
                last_reset: today,
                author_type: authorType,
            };
            await this.state.storage.put('budget', newBudget);
            return newBudget;
        }

        return budget;
    }

    /**
     * Calculate next midnight UTC.
     */
    nextResetTime() {
        const now = new Date();
        const tomorrow = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1
        ));
        return tomorrow.toISOString();
    }
}
