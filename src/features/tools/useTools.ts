import { useCallback, useEffect, useRef, useState } from 'react';
import { getTool, getToolStatuses, setConnectedTools } from './toolRegistry';
import { fetchConnections } from './googleClient';
import { ToolStatus } from './types';

// Ensure all connectors are registered
import './connectors';

/** How often to re-ask the server which tools are connected. */
const CONNECTION_POLL_MS = 30_000;
/** How often to re-read local statuses (the WhatsApp bridge flips locally). */
const STATUS_POLL_MS = 3_000;

/**
 * Tool connection state for the UI.
 *
 * The authority is the SERVER. This hook pulls `/api/oauth/connections` into the
 * registry's snapshot, which is what `Tool.isAuthenticated()` reads.
 *
 * What this replaces: the module used to call `startTokenRefreshTimer()` at import
 * time, starting a five-minute interval that re-ran Google's token client in the
 * background to keep localStorage tokens alive. Refresh is now a server concern,
 * done with a refresh token at the moment a call needs one.
 */
export function useTools() {
    const [toolStatuses, setToolStatuses] = useState<ToolStatus[]>([]);
    const [authInProgress, setAuthInProgress] = useState<string | null>(null);
    /** True when the server has Google OAuth configured. */
    const [oauthConfigured, setOauthConfigured] = useState(true);
    const mounted = useRef(true);

    const refreshStatuses = useCallback(() => {
        setToolStatuses(getToolStatuses());
    }, []);

    /** Pull connection state from the server, then re-read statuses. */
    const syncConnections = useCallback(async () => {
        const snapshot = await fetchConnections();
        if (!mounted.current) return;

        setConnectedTools(snapshot.connections.filter(c => c.connected).map(c => c.toolId));
        setOauthConfigured(snapshot.configured);
        refreshStatuses();
    }, [refreshStatuses]);

    useEffect(() => {
        mounted.current = true;
        void syncConnections();
        return () => {
            mounted.current = false;
        };
    }, [syncConnections]);

    // Local statuses change without a server round trip (the WhatsApp bridge
    // reports through localStorage), so they are polled more often than the
    // server-held connections.
    useEffect(() => {
        const statusTimer = setInterval(refreshStatuses, STATUS_POLL_MS);
        const connectionTimer = setInterval(() => void syncConnections(), CONNECTION_POLL_MS);
        return () => {
            clearInterval(statusTimer);
            clearInterval(connectionTimer);
        };
    }, [refreshStatuses, syncConnections]);

    const authenticate = useCallback(
        async (toolId: string) => {
            const tool = getTool(toolId);
            if (!tool) return;

            setAuthInProgress(toolId);
            try {
                await tool.authenticate();
                // Read the outcome back from the server rather than assuming it.
                await syncConnections();
            } catch (err) {
                console.error(`Auth failed for ${toolId}:`, err);
                throw err;
            } finally {
                if (mounted.current) setAuthInProgress(null);
            }
        },
        [syncConnections]
    );

    const disconnect = useCallback(
        async (toolId: string) => {
            const tool = getTool(toolId);
            if (!tool) return;
            tool.disconnect();
            await syncConnections();
        },
        [syncConnections]
    );

    return {
        toolStatuses,
        authInProgress,
        oauthConfigured,
        authenticate,
        disconnect,
        refreshStatuses,
        syncConnections
    };
}
