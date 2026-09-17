import { useState, useCallback, useEffect } from 'react';
import { getTool, getToolStatuses, startTokenRefreshTimer } from './toolRegistry';
import { ToolStatus } from './types';

// Ensure all connectors are registered
import './connectors';

// Start the background token refresh timer once
startTokenRefreshTimer();

/**
 * React hook for managing tool authentication in the UI.
 * Provides auth state, authenticate/disconnect callbacks, and a full tools status list.
 */
export function useTools() {
    const [toolStatuses, setToolStatuses] = useState<ToolStatus[]>([]);
    const [authInProgress, setAuthInProgress] = useState<string | null>(null);

    // Refresh statuses from registry
    const refreshStatuses = useCallback(() => {
        setToolStatuses(getToolStatuses());
    }, []);

    // Load on mount
    useEffect(() => {
        refreshStatuses();
    }, [refreshStatuses]);

    // Poll for status updates every 3 seconds (useful for WhatsApp bridge status)
    useEffect(() => {
        const interval = setInterval(refreshStatuses, 3000);
        return () => clearInterval(interval);
    }, [refreshStatuses]);

    const authenticate = useCallback(async (toolId: string) => {
        const tool = getTool(toolId);
        if (!tool) return;

        setAuthInProgress(toolId);
        try {
            await tool.authenticate();
            refreshStatuses();
        } catch (err) {
            console.error(`Auth failed for ${toolId}:`, err);
            throw err;
        } finally {
            setAuthInProgress(null);
        }
    }, [refreshStatuses]);

    const disconnect = useCallback((toolId: string) => {
        const tool = getTool(toolId);
        if (!tool) return;
        tool.disconnect();
        refreshStatuses();
    }, [refreshStatuses]);

    return {
        toolStatuses,
        authInProgress,
        authenticate,
        disconnect,
        refreshStatuses
    };
}
