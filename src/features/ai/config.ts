
export const AI_CONFIG = {
    provider: 'openrouter' as 'ollama' | 'gemini' | 'openrouter',
    ollamaModel: 'deepseek-r1:8b',
    geminiModel: 'gemini-3.5-flash',
    openRouterModel: 'openai/gpt-oss-120b',
    benchmark: {
        openrouter: { latencyMs: 1200, costScore: 7, reliability: 8, quality: 8 },
        gemini: { latencyMs: 900, costScore: 8, reliability: 9, quality: 9 },
        ollama: { latencyMs: 500, costScore: 9, reliability: 6, quality: 7 }
    },
    providerOptions: [
        { id: 'auto', label: 'Auto best fit', provider: 'auto' },
        { id: 'openrouter', label: 'OpenRouter', provider: 'openrouter' },
        { id: 'gemini', label: 'Gemini', provider: 'gemini' },
        { id: 'ollama', label: 'Ollama', provider: 'ollama' }
    ],
    getRecommendedModel(prompt: string = '', preferredProvider?: 'ollama' | 'gemini' | 'openrouter' | 'auto') {
        if (preferredProvider && preferredProvider !== 'auto') {
            return preferredProvider === 'ollama' ? this.ollamaModel : preferredProvider === 'gemini' ? this.geminiModel : this.openRouterModel;
        }

        const normalized = prompt.toLowerCase();
        if (/quick|simple|draft|reply|email|message|summarize|short/.test(normalized)) {
            return this.geminiModel;
        }
        if (/analyze|research|compare|plan|architecture|complex|strategy|reason/.test(normalized)) {
            return this.openRouterModel;
        }
        if (/offline|local|private|secure|internal/.test(normalized)) {
            return this.ollamaModel;
        }
        return this.geminiModel;
    },
    getProviderHeuristic(prompt: string = '') {
        const normalized = prompt.toLowerCase();
        if (/offline|local|private|secure|internal/.test(normalized)) return 'ollama';
        if (/analyze|research|compare|plan|architecture|complex|reason/.test(normalized)) return 'openrouter';
        return 'gemini';
    }
};
