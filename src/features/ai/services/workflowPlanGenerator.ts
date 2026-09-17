import { Workflow, WorkflowNode, WorkflowEdge } from '@features/workflow/types';
import { findReusableToolTemplate, getAllTools, rankToolMatches, describeCatalog, CapabilityMatch } from '@features/tools/toolRegistry';
import { requestPlan, requestWorkflow } from '@features/ai/services/aiClient';
import { normalizeGeneratedWorkflow } from '@features/ai/services/workflowNormalizer';
import { NodeType } from '@/shared/types';


export interface WorkflowPlan {
    title: string;
    description: string;
    steps: PlanStep[];
    estimatedTime: string;
    requiredTools: string[];
    capabilityMatches?: CapabilityMatch[];
}

export interface PlanStep {
    id: string;
    order: number;
    type: 'trigger' | 'process' | 'decision' | 'tool' | 'output';
    label: string;
    description: string;
    toolName?: string;
    inputs?: string[];
    outputs?: string[];
}

const buildIntentPlanFromPrompt = (prompt: string, matches: Array<{ toolId: string; toolName: string; actionName: string; score: number; rationale: string[] }>): WorkflowPlan => {
    const normalized = prompt.toLowerCase();
    const isScraping = /(scrap|crawl|fetch|collect|extract|read from .*page|product page|web page)/i.test(prompt);
    const isSentiment = /(sentiment|classif|analyz|categorize|group.*feedback|review.*score|tone)/i.test(prompt);
    const isSaving = /(save|store|log|sheet|google sheets|spreadsheet|write.*sheet|append.*row)/i.test(prompt);
    const isEmailing = /(email|gmail)/i.test(prompt);
    const isSlacking = /(slack|notify|message)/i.test(prompt);

    const requiredTools = Array.from(new Set(matches.slice(0, 4).map(match => match.toolId)));

    const steps: PlanStep[] = [
        {
            id: 'start',
            order: 1,
            type: 'trigger',
            label: 'Start',
            description: 'Initialize the workflow and capture the input request.'
        }
    ];

    if (isScraping || /read|capture|collect|fetch/.test(normalized)) {
        steps.push({
            id: 'capture_data',
            order: 2,
            type: 'process',
            label: 'Capture source data',
            description: 'Collect the relevant records or page content needed for the workflow.',
            inputs: ['source_url', 'input'],
            outputs: ['raw_data']
        });
    }

    if (isSentiment || /group|summarize|analyz|review|feedback/.test(normalized)) {
        steps.push({
            id: 'analyze_data',
            order: steps.length + 1,
            type: 'process',
            label: 'Analyze and categorize results',
            description: 'Group the inputs by meaning, sentiment, or category before outputting them.',
            inputs: ['raw_data', 'context'],
            outputs: ['categorized_results']
        });
    }

    if (isSaving || isEmailing || isSlacking) {
        steps.push({
            id: 'action_result',
            order: steps.length + 1,
            type: 'tool',
            label: isSaving ? 'Save results to spreadsheet' : isEmailing ? 'Send result via email' : 'Send result to Slack',
            description: isSaving
                ? 'Write the structured output to the destination sheet or spreadsheet.'
                : isEmailing
                    ? 'Send the processed result to the final recipient or team.'
                    : 'Notify the relevant audience with the final result.',
            toolName: isSaving ? 'Google Sheets' : isEmailing ? 'Gmail' : 'Slack',
            inputs: ['categorized_results', 'input'],
            outputs: ['saved_result']
        });
    }

    if (!steps.some(step => step.type === 'output')) {
        steps.push({
            id: 'result',
            order: steps.length + 1,
            type: 'output',
            label: 'Return result',
            description: 'Return the final workflow result to the user or downstream node.'
        });
    }

    const title = isScraping && isSentiment && isSaving
        ? 'Review analysis workflow'
        : requiredTools.length > 1
            ? `Multi-step ${requiredTools.length}-tool workflow`
            : `${matches[0]?.toolName || 'Workflow'} workflow`;

    return {
        title,
        description: prompt,
        steps,
        estimatedTime: requiredTools.length > 2 ? 'Medium' : 'Fast',
        requiredTools,
        capabilityMatches: matches.slice(0, 5) as CapabilityMatch[]
    };
};

export const buildPlanFromPromptMatches = (
    prompt: string,
    matches: Array<{ toolId: string; toolName: string; actionName: string; score: number; rationale: string[] }>
): WorkflowPlan => {
    const hasMultiIntent = /(scrap|collect|extract|sentiment|analyz|group|save|write|sheet|notify|email|slack)/i.test(prompt) &&
        /(scrap|collect|extract|sentiment|analyz|group|save|write|sheet|notify|email|slack)/i.test(prompt);

    if (hasMultiIntent) {
        return buildIntentPlanFromPrompt(prompt, matches);
    }

    const uniqueMatches = Array.from(
        new Map(matches.map(match => [`${match.toolId}:${match.actionName}`, match])).values()
    );

    const orderedMatches = uniqueMatches.slice(0, 4);
    const requiredTools = [...new Set(orderedMatches.map(match => match.toolId))];
    const summaryLabel = requiredTools.length > 1 ? 'Combine results' : 'Return result';
    const title = requiredTools.length > 1
        ? `Multi-step ${requiredTools.length}-tool workflow`
        : `${orderedMatches[0]?.toolName || 'Workflow'} workflow`;

    const steps: PlanStep[] = [
        {
            id: 'start',
            order: 1,
            type: 'trigger',
            label: 'Start',
            description: 'Initialize the workflow and capture the input request.',
            inputs: ['source_url', 'input', 'query', 'context'],
            outputs: ['request', 'context']
        }
    ];

    if (orderedMatches.length > 0) {
        const toolStepCount = Math.min(orderedMatches.length, 2);
        orderedMatches.slice(0, toolStepCount).forEach((match, index) => {
            steps.push({
                id: `tool_${index + 1}`,
                order: index + 2,
                type: 'tool',
                label: `${match.toolName}: ${match.actionName.replace(/_/g, ' ')}`,
                description: `Use the built-in ${match.toolName} action to ${match.actionName.replace(/_/g, ' ')}.`,
                toolName: match.toolName,
                inputs: [
                    'input',
                    'context',
                    ...((match.actionName.includes('send') || match.actionName.includes('append')) ? ['target', 'message'] : [])
                ],
                outputs: ['result']
            });
        });
    }

    steps.push({
        id: 'result',
        order: steps.length + 1,
        type: 'output',
        label: summaryLabel,
        description: 'Return the final workflow result to the user or downstream node.'
    });

    return {
        title,
        description: prompt,
        steps,
        estimatedTime: requiredTools.length > 2 ? 'Medium' : 'Fast',
        requiredTools,
        capabilityMatches: orderedMatches as CapabilityMatch[]
    };
};

/**
 * Generate a workflow execution plan from a user prompt
 * This is fast - just creates an outline before deep generation
 */
const detectMultiStepWorkflowIntent = (prompt: string): string[] => {
    const normalized = prompt.toLowerCase();
    const intentSignals = [
        { key: 'scrape', match: /(scrap|crawl|fetch|extract|read.*page|product page|web page)/i.test(normalized) },
        { key: 'analyze', match: /(sentiment|analyz|summariz|categorize|group.*feedback|review.*score|score.*review|tone)/i.test(normalized) },
        { key: 'save', match: /(save|store|log|write.*sheet|append.*row|google sheets|spreadsheet)/i.test(normalized) },
        { key: 'notify', match: /(email|gmail|slack|notify|message)/i.test(normalized) },
        { key: 'trigger', match: /(trigger|when|schedule|if|route)/i.test(normalized) }
    ];

    return intentSignals.filter(signal => signal.match).map(signal => signal.key);
};

export const generateWorkflowPlan = async (prompt: string, model: string): Promise<WorkflowPlan> => {
    const rankedMatches = rankToolMatches(prompt);
    const multiStepIntent = detectMultiStepWorkflowIntent(prompt);

    if (multiStepIntent.length >= 2) {
        return buildPlanFromPromptMatches(prompt, rankedMatches.length > 0 ? rankedMatches : [{
            toolId: 'google_sheets',
            toolName: 'Google Sheets',
            actionName: 'append_row',
            score: 50,
            rationale: ['multi-step workflow intent']
        }]);
    }

    if (rankedMatches.length > 0) {
        return buildPlanFromPromptMatches(prompt, rankedMatches);
    }

    const reusableMatch = findReusableToolTemplate(prompt);
    if (reusableMatch) {
        return {
            title: `${reusableMatch.toolName} workflow`,
            description: `Workflow uses the built-in ${reusableMatch.toolName} action for ${reusableMatch.toolAction.replace(/_/g, ' ')}.`,
            steps: [
                {
                    id: 'start',
                    order: 1,
                    type: 'trigger',
                    label: 'Start',
                    description: 'Initialize the workflow and capture the required input.',
                    inputs: ['source_url', 'input', 'query', 'context'],
                    outputs: ['request', 'context']
                },
                {
                    id: reusableMatch.id,
                    order: 2,
                    type: 'tool',
                    label: reusableMatch.label,
                    description: reusableMatch.description,
                    toolName: reusableMatch.toolName,
                    inputs: reusableMatch.inputKeys,
                    outputs: reusableMatch.outputKeys
                },
                { id: 'result', order: 3, type: 'output', label: 'Result', description: 'Return the result of the operation.' }
            ],
            estimatedTime: 'Fast',
            requiredTools: [reusableMatch.toolId]
        };
    }

    // Ask the server to plan. The prompt template and the provider credential
    // both live server-side; the browser only supplies the request and the
    // catalog of tools that actually exist. Task 8 replaces the heuristic paths
    // above so this becomes the only route.
    try {
        const { plan } = await requestPlan({
            prompt,
            catalog: describeCatalog(),
            hints: rankedMatches.slice(0, 8).map(match => ({
                toolId: match.toolId,
                actionName: match.actionName,
                score: match.score
            })),
            model
        });
        return plan as WorkflowPlan;
    } catch (err) {
        console.error('Plan generation error:', err);
        throw err;
    }
};

/**
 * Convert a plan into a partial workflow skeleton
 */
export const planToWorkflow = (plan: WorkflowPlan): Workflow => {
    const nodes: WorkflowNode[] = [];
    const edges: WorkflowEdge[] = [];
    const yPosition = 0;

    plan.steps.forEach((step, idx) => {
        const nodeId = step.id || `node_${idx}`;
        let nodeType: NodeType = NodeType.AI_AGENT;

        if (step.type === 'trigger') nodeType = NodeType.TRIGGER;
        else if (step.type === 'tool') nodeType = NodeType.TOOL;
        else if (step.type === 'decision') nodeType = NodeType.LOGIC;
        else if (step.type === 'output') nodeType = NodeType.OUTPUT;

        const inputKeys = step.inputs && step.inputs.length > 0
            ? step.inputs
            : idx === 0
                ? ['source_url', 'input', 'query', 'context']
                : ['input'];

        const outputKeys = step.outputs && step.outputs.length > 0
            ? step.outputs
            : idx === 0
                ? ['request', 'context']
                : ['result'];

        nodes.push({
            id: nodeId,
            type: nodeType,
            position: { x: 300 + idx * 250, y: yPosition },
            data: {
                label: step.label,
                description: step.description,
                type: nodeType,
                stateContract: {
                    inputKeys,
                    outputKeys
                }
            }
        } as WorkflowNode);

        // Connect to previous node
        if (idx > 0) {
            edges.push({
                id: `edge_${idx - 1}_${idx}`,
                source: nodes[idx - 1].id,
                target: nodeId,
                animated: true
            } as WorkflowEdge);
        }
    });

    return {
        nodes,
        edges,
        initialState: {}
    };
};

/**
 * Generate a single node based on plan step and available connectors
 */
const getCanonicalStepNode = (step: PlanStep): Record<string, any> | null => {
    const normalized = `${step.label || ''} ${step.description || ''}`.toLowerCase();

    if (/start|initialize|capture the input/.test(normalized)) {
        return {
            label: 'Start',
            description: 'Initialize the workflow and capture the input request.',
            stateContract: { inputKeys: [], outputKeys: ['request'] }
        };
    }

    if (/(scrap|crawl|extract|fetch|collect|read.*page|source data|capture)/.test(normalized)) {
        return {
            label: 'Scrape source data',
            description: 'Read the target page or source content and extract the relevant records.',
            stateContract: { inputKeys: ['source_url'], outputKeys: ['raw_data'], externalInputKeys: ['source_url'] }
        };
    }

    if (/(analyz|sentiment|categor|group|review|summariz|classif|feedback)/.test(normalized)) {
        return {
            label: 'Analyze and group results',
            description: 'Classify, score, or summarize the extracted data before downstream actions.',
            stateContract: { inputKeys: ['raw_data', 'context'], outputKeys: ['categorized_results'] }
        };
    }

    if (/(save|sheet|spreadsheet|append|log|store|report)/.test(normalized)) {
        return {
            label: 'Save results to Google Sheets',
            description: 'Write the final structured output to a spreadsheet for reporting and follow-up.',
            toolId: 'google_sheets',
            toolAction: 'append_row',
            stateContract: {
                inputKeys: ['spreadsheetId', 'categorized_results', 'rows', 'data'],
                outputKeys: ['updatedRange', 'updatedRows'],
                externalInputKeys: ['spreadsheetId']
            }
        };
    }

    if (/(email|gmail|send|notify)/.test(normalized)) {
        return {
            label: 'Send result via email',
            description: 'Notify the user or team with the processed output.',
            toolId: 'gmail',
            toolAction: 'send_email',
            stateContract: {
                inputKeys: ['to', 'subject', 'body', 'result'],
                outputKeys: ['email_sent_id', 'email_status']
            }
        };
    }

    if (/(slack|message|alert)/.test(normalized)) {
        return {
            label: 'Notify in Slack',
            description: 'Send the final result or summary to the relevant Slack channel.',
            toolId: 'slack',
            toolAction: 'send_message',
            stateContract: {
                inputKeys: ['channel', 'message', 'result'],
                outputKeys: ['sent_message_id']
            }
        };
    }

    if (/(result|return|final|output)/.test(normalized)) {
        return {
            label: 'Return result',
            description: 'Return the final workflow result to the user or downstream node.',
            stateContract: { inputKeys: ['result'], outputKeys: ['final_output'] }
        };
    }

    if (step.toolName) {
        return {
            label: step.label,
            description: step.description,
            toolId: step.toolName === 'Google Sheets' ? 'google_sheets' : undefined,
            toolAction: step.toolName === 'Google Sheets' ? 'append_row' : undefined,
            stateContract: {
                inputKeys: step.inputs || ['input'],
                outputKeys: step.outputs || ['result']
            }
        };
    }

    return null;
};

export const generateNodeForStep = async (
    step: PlanStep,
    model: string,
    availableTools: string[],
    preferredMatches: CapabilityMatch[] = []
): Promise<Record<string, any>> => {
    const canonical = getCanonicalStepNode(step);
    if (canonical) {
        return canonical;
    }

    const rankedMatches = preferredMatches.length > 0 ? preferredMatches : rankToolMatches(`${step.label} ${step.description}`);
    const reusableMatch = rankedMatches.length > 0 ? findReusableToolTemplate(`${step.label} ${step.description}`) : null;
    const preferredToolMatch = preferredMatches.length > 0
        ? preferredMatches.find(match => {
            const labelText = `${step.label} ${step.description}`.toLowerCase();
            const toolName = match.toolName.toLowerCase();
            const actionName = match.actionName.replace(/_/g, ' ').toLowerCase();
            return labelText.includes(toolName) || labelText.includes(actionName) || labelText.includes(match.toolId.toLowerCase());
        }) || preferredMatches[0]
        : null;

    if (reusableMatch && (availableTools.length === 0 || availableTools.includes(reusableMatch.toolId))) {
        const bestMatchByStep = preferredToolMatch || rankedMatches.find(match => match.toolId === reusableMatch.toolId && match.actionName === reusableMatch.toolAction) || rankedMatches[0];
        return {
            label: reusableMatch.label,
            description: reusableMatch.description,
            toolId: reusableMatch.toolId,
            toolAction: reusableMatch.toolAction,
            capabilityMatch: bestMatchByStep,
            stateContract: {
                inputKeys: reusableMatch.inputKeys,
                outputKeys: reusableMatch.outputKeys
            }
        };
    }

    if (preferredToolMatch) {
        const tool = getAllTools().find(t => t.id === preferredToolMatch.toolId);
        const action = tool?.actions.find(a => a.name === preferredToolMatch.actionName);
        if (tool && action && (availableTools.length === 0 || availableTools.includes(tool.id))) {
            return {
                label: `${tool.name}: ${action.name.replace(/_/g, ' ')}`,
                description: action.description,
                toolId: tool.id,
                toolAction: action.name,
                capabilityMatch: preferredToolMatch,
                stateContract: {
                    inputKeys: action.inputKeys,
                    outputKeys: action.outputKeys
                }
            };
        }
    }

    const nodePrompt = `Generate a workflow node that performs this task:\n\nSTEP: "${step.label}"\nDESCRIPTION: "${step.description}"\nTYPE: "${step.type}"\n\nAvailable tools: ${availableTools.join(', ')}\n\nReturn ONLY valid JSON:\n{\n  "label": "Node name",\n  "description": "Instructions",\n  "toolId": "tool_id_if_applicable",\n  "toolAction": "action_name_if_applicable",\n  "stateContract": {\n    "inputKeys": ["key1"],\n    "outputKeys": ["result"]\n  }\n}`;

    // Fallback: ask the server to generate a small workflow for this step and
    // extract the node from it. The provider credential stays server-side.
    try {
        const { workflow } = await requestWorkflow({
            prompt: nodePrompt,
            catalog: describeCatalog(),
            model
        });
        const wf = normalizeGeneratedWorkflow(workflow);
        // If returned workflow has a node matching label, use it; else use first node
        const found = wf.nodes.find(n => (n.data?.label || '').toLowerCase().includes((step.label || '').toLowerCase())) || wf.nodes[0];
        if (found) {
            return {
                label: found.data?.label || step.label,
                description: found.data?.description || step.description,
                toolId: found.data?.toolId,
                toolAction: found.data?.toolAction,
                stateContract: found.data?.stateContract || { inputKeys: step.inputs || [], outputKeys: step.outputs || ['result'] }
            };
        }
    } catch (err) {
        console.error(`Failed to generate node for step "${step.label}" via local AI:`, err);
    }

    // Final fallback: basic node
    return {
        label: step.label,
        description: step.description,
        stateContract: {
            inputKeys: step.inputs || [],
            outputKeys: step.outputs || ['result']
        }
    };
};
