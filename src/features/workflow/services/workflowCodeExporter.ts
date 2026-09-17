import { Node, Edge } from 'reactflow';

export interface ExportApproach {
  id: string;
  name: string;
  example: string;
  bestFor: string;
  language: string;
  extension: string;
  pipInstall: string;
  envVars: string[];
  description: string;
  generateCode: (context: WorkflowExportContext) => string;
}

export interface WorkflowExportContext {
  title: string;
  prompt?: string;
  nodes: Node[];
  edges: Edge[];
  initialState?: Record<string, any>;
}

interface ParsedNode {
  id: string;
  varName: string;
  label: string;
  description: string;
  type: string;
  toolId?: string;
  toolAction?: string;
  inputKeys: string[];
  outputKeys: string[];
}

function sanitizeIdentifier(name: string): string {
  const clean = (name || 'step')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean || 'step';
}

function parseWorkflow(context: WorkflowExportContext): {
  orderedNodes: ParsedNode[];
  allInputKeys: string[];
  allOutputKeys: string[];
  stateKeys: string[];
} {
  const { nodes, edges } = context;

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  nodes.forEach((n) => {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  });

  edges.forEach((e) => {
    if (inDegree.has(e.target)) {
      inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
    }
    if (adj.has(e.source)) {
      adj.get(e.source)?.push(e.target);
    }
  });

  const queue: string[] = [];
  inDegree.forEach((degree, id) => {
    if (degree === 0) queue.push(id);
  });

  const orderedIds: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    orderedIds.push(curr);
    for (const neighbor of adj.get(curr) || []) {
      const nextDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, nextDegree);
      if (nextDegree === 0) queue.push(neighbor);
    }
  }

  nodes.forEach((n) => {
    if (!orderedIds.includes(n.id)) orderedIds.push(n.id);
  });

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const parsedNodes: ParsedNode[] = orderedIds
    .map((id) => nodeMap.get(id))
    .filter(Boolean)
    .map((n, idx) => {
      const node = n!;
      const label = node.data?.label || `Node_${idx + 1}`;
      const stateContract = node.data?.stateContract || {};
      const inputKeys: string[] = stateContract.inputKeys || [];
      const outputKeys: string[] = stateContract.outputKeys || [];
      const varName = `${sanitizeIdentifier(label)}_${idx + 1}`;

      return {
        id: node.id,
        varName,
        label,
        description: node.data?.description || `Processes ${label} step in the workflow.`,
        type: node.data?.type || node.type || 'ai_agent',
        toolId: node.data?.toolId,
        toolAction: node.data?.toolAction,
        inputKeys,
        outputKeys,
      };
    });

  const inputKeySet = new Set<string>();
  const outputKeySet = new Set<string>();

  parsedNodes.forEach((pn) => {
    pn.inputKeys.forEach((k) => inputKeySet.add(k));
    pn.outputKeys.forEach((k) => outputKeySet.add(k));
  });

  const stateKeys = Array.from(new Set([...inputKeySet, ...outputKeySet]));

  return {
    orderedNodes: parsedNodes,
    allInputKeys: Array.from(inputKeySet),
    allOutputKeys: Array.from(outputKeySet),
    stateKeys:
      stateKeys.length > 0
        ? stateKeys
        : ['input_query', 'extracted_data', 'analysis_summary', 'result'],
  };
}

function escapePyString(str: string): string {
  return (str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// -------------------------------------------------------------
// 1. RAW LLM API + PYTHON
// -------------------------------------------------------------
function generateRawLLM(ctx: WorkflowExportContext): string {
  const { orderedNodes, stateKeys } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent Generated Workflow';

  const nodeFunctions = orderedNodes
    .map((node) => {
      if (node.toolId) {
        const outputDict =
          node.outputKeys.length > 0
            ? node.outputKeys
                .map((k) => `        "${k}": "${escapePyString(node.label)} result"`)
                .join(',\n')
            : '        "status": "success"';

        return `# Tool step: ${node.label} (${node.toolId})
def ${node.varName}(state: Dict[str, Any]) -> Dict[str, Any]:
    print(f"Executing tool step: ${node.label}...")
    # Inputs: ${node.inputKeys.join(', ') || 'state'}
    return {
${outputDict}
    }`;
      } else {
        const fallbackOutput =
          node.outputKeys.length > 0
            ? node.outputKeys.map((k) => `"${k}": raw_output`).join(', ')
            : '"output": raw_output';

        return `# Agent step: ${node.label}
def ${node.varName}(state: Dict[str, Any]) -> Dict[str, Any]:
    print(f"Executing agent step: ${node.label}...")
    system_prompt = (
        "You are an AI assistant executing the following task:\\n"
        "${escapePyString(node.description)}\\n"
        "Return the output as a valid JSON object with keys: ${node.outputKeys.join(', ') || 'result'}."
    )
    user_prompt = f"Current state context: {json.dumps(state, indent=2)}"
    raw_output = call_llm(system_prompt, user_prompt)
    try:
        data = json.loads(raw_output)
        return data if isinstance(data, dict) else {"result": raw_output}
    except Exception:
        return {${fallbackOutput}}`;
      }
    })
    .join('\n\n');

  const executionSteps = orderedNodes
    .map(
      (node) =>
        `    # Step: ${node.label}\n` +
        `    step_output = ${node.varName}(state)\n` +
        `    state.update(step_output)\n` +
        `    print(f"✓ Completed: ${node.label}\\n")`,
    )
    .join('\n');

  const stateInitEntries = stateKeys.map((k) => `        "${k}": "Sample ${k}"`).join(',\n');

  return `"""
Workflow: ${title}
Approach: 1. Raw LLM API + Python
Examples: OpenAI / Gemini / Claude SDKs
Best for: Learning fundamentals, simple agents, maximum portability
"""

import os
import json
from typing import Dict, Any
from openai import OpenAI

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", "your-api-key-here"))

def call_llm(system_prompt: str, user_prompt: str) -> str:
    """Helper to call LLM directly with structured response."""
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        temperature=0.2
    )
    return response.choices[0].message.content or ""

${nodeFunctions}

def run_workflow(initial_data: Dict[str, Any] = None) -> Dict[str, Any]:
    state: Dict[str, Any] = {
${stateInitEntries},
        **(initial_data or {})
    }
    
    print("=== STARTING WORKFLOW ===")
    print(f"Initial State: {list(state.keys())}\\n")

${executionSteps}

    print("=== WORKFLOW FINISHED ===")
    return state

if __name__ == "__main__":
    final_state = run_workflow({
        "user_request": "${escapePyString(ctx.prompt || 'Execute automation')}"
    })
    print("Final State Output:")
    print(json.dumps(final_state, indent=2))
`;
}

// -------------------------------------------------------------
// 2. GOOGLE ADK / GENAI
// -------------------------------------------------------------
function generateGoogleADK(ctx: WorkflowExportContext): string {
  const { orderedNodes } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent Google ADK Workflow';

  const toolDeclarations = orderedNodes
    .filter((n) => n.toolId)
    .map((n) => {
      const fnName = `${sanitizeIdentifier(n.toolId || 'tool')}_${sanitizeIdentifier(n.toolAction || 'action')}`;
      const params = n.inputKeys.map((k) => `${k}: str = ""`).join(', ');
      return `# Built-in tool declaration for ${n.label}
def ${fnName}(${params}) -> str:
    """Executes ${n.label} in the Google workspace/ecosystem."""
    return "Executed ${n.toolId} action ${n.toolAction} successfully."`;
    })
    .join('\n\n');

  const stepMethods = orderedNodes
    .map((node) => {
      return `    def step_${node.varName}(self, input_context: dict) -> dict:
        print(f"-> Running step: ${node.label}")
        system_instruction = (
            "You are an agent in a structured Google workflow.\\n"
            "Task: ${escapePyString(node.description)}\\n"
            "Expected output keys: ${node.outputKeys.join(', ') || 'result'}."
        )
        
        response = self.client.models.generate_content(
            model=self.model,
            contents=[f"State context: {json.dumps(input_context)}"],
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.2,
                response_mime_type="application/json"
            )
        )
        try:
            return json.loads(response.text)
        except Exception:
            return {"raw_text": response.text}`;
    })
    .join('\n\n');

  const executionSteps = orderedNodes
    .map(
      (node) =>
        `        step_result = self.step_${node.varName}(self.state)\n        self.state.update(step_result)`,
    )
    .join('\n');

  return `"""
Workflow: ${title}
Approach: 2. Google ADK / Gemini GenAI SDK
Examples: Gemini + ADK (Agent Development Kit)
Best for: Google ecosystem, multi-agent systems, multimodal tasks
"""

import os
import json
from google import genai
from google.genai import types

client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY", "your-gemini-key"))

${toolDeclarations}

class WorkflowOrchestrator:
    def __init__(self):
        self.client = client
        self.model = "gemini-2.5-flash"
        self.state = {}

${stepMethods}

    def execute(self, initial_request: str = "") -> dict:
        self.state = {
            "request": initial_request or "${escapePyString(ctx.prompt || 'Run workflow')}"
        }
        
${executionSteps}
        
        return self.state

if __name__ == "__main__":
    app = WorkflowOrchestrator()
    results = app.execute("${escapePyString(ctx.prompt || 'Start automation')}")
    print("\\nWorkflow Completed Successfully:")
    print(json.dumps(results, indent=2))
`;
}

// -------------------------------------------------------------
// 3. LANGCHAIN
// -------------------------------------------------------------
function generateLangChain(ctx: WorkflowExportContext): string {
  const { orderedNodes, stateKeys } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent LangChain Workflow';

  const toolsDef = orderedNodes
    .filter((n) => n.toolId)
    .map((n) => {
      const fnName = `${sanitizeIdentifier(n.toolId || 'tool')}_${sanitizeIdentifier(n.toolAction || 'action')}`;
      const params = n.inputKeys.map((k) => `${k}: str = ""`).join(', ');
      return `@tool
def ${fnName}(${params}) -> str:
    """Tool: ${n.label}. ${escapePyString(n.description)}"""
    return "Successfully executed ${n.label}"`;
    })
    .join('\n\n');

  const chainDefs = orderedNodes
    .map((node) => {
      return `def create_${node.varName}_chain():
    prompt = ChatPromptTemplate.from_messages([
        ("system", "You are an automated step in a LangChain workflow.\\n"
                   "Step: ${node.label}\\n"
                   "Description: ${escapePyString(node.description)}\\n"
                   "Output JSON format with keys: ${node.outputKeys.join(', ') || 'result'}"),
        ("human", "Current State:\\n{state_json}")
    ])
    return prompt | llm | JsonOutputParser()`;
    })
    .join('\n\n');

  const chainExecution = orderedNodes
    .map(
      (node) =>
        `    print("Executing: ${node.label}")\n` +
        `    chain_${node.varName} = create_${node.varName}_chain()\n` +
        `    step_res = chain_${node.varName}.invoke({"state_json": str(state)})\n` +
        `    if isinstance(step_res, dict):\n` +
        `        state.update(step_res)\n` +
        `    else:\n` +
        `        state["${node.outputKeys[0] || 'result'}"] = step_res`,
    )
    .join('\n\n');

  const stateInitEntries = stateKeys.map((k) => `        "${k}": ""`).join(',\n');

  return `"""
Workflow: ${title}
Approach: 3. LangChain
Examples: LangChain + LCEL + Tools + RAG
Best for: General GenAI applications, enterprise integrations
"""

import os
from typing import Dict, Any
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-4o-mini",
    temperature=0.2,
    api_key=os.environ.get("OPENAI_API_KEY", "your-api-key")
)

${toolsDef}

${chainDefs}

def run_langchain_workflow(initial_inputs: Dict[str, Any] = None) -> Dict[str, Any]:
    state = {
${stateInitEntries},
        **(initial_inputs or {})
    }
    
    print("Starting LangChain Workflow Pipeline...")
    
${chainExecution}

    return state

if __name__ == "__main__":
    result = run_langchain_workflow({
        "input_query": "${escapePyString(ctx.prompt || 'Start automation')}"
    })
    import json
    print("Final Pipeline State:")
    print(json.dumps(result, indent=2))
`;
}

// -------------------------------------------------------------
// 4. LANGGRAPH
// -------------------------------------------------------------
function generateLangGraph(ctx: WorkflowExportContext): string {
  const { orderedNodes, stateKeys } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent LangGraph Workflow';

  const nodeFunctions = orderedNodes
    .map((node) => {
      if (node.toolId) {
        const ret =
          node.outputKeys.length > 0
            ? node.outputKeys.map((k) => `        "${k}": "${node.label} completed"`).join(',\n')
            : '        "status": "done"';
        return `def ${node.varName}_node(state: WorkflowState) -> Dict[str, Any]:
    print(f"Executing LangGraph node: ${node.label}")
    return {
${ret}
    }`;
      } else {
        const ret =
          node.outputKeys.length > 0
            ? node.outputKeys.map((k) => `        "${k}": response.content`).join(',\n')
            : '        "result": response.content';
        return `def ${node.varName}_node(state: WorkflowState) -> Dict[str, Any]:
    print(f"Executing LangGraph node: ${node.label}")
    prompt = (
        "Execute node '${node.label}'.\\n"
        "${escapePyString(node.description)}\\n"
        "State inputs: ${node.inputKeys.join(', ') || 'none'}"
    )
    response = llm.invoke([
        SystemMessage(content=prompt),
        HumanMessage(content=f"Context: {state}")
    ])
    return {
${ret}
    }`;
      }
    })
    .join('\n\n');

  const addNodes = orderedNodes
    .map((n) => `    builder.add_node("${n.varName}", ${n.varName}_node)`)
    .join('\n');
  const addEdges = orderedNodes
    .map((node, idx) => {
      if (idx < orderedNodes.length - 1) {
        return `    builder.add_edge("${node.varName}", "${orderedNodes[idx + 1].varName}")`;
      } else {
        return `    builder.add_edge("${node.varName}", END)`;
      }
    })
    .join('\n');

  const stateTypeEntries = stateKeys.map((k) => `    ${k}: Any`).join('\n');
  const stateInitEntries = stateKeys.map((k) => `        "${k}": "Initial ${k}"`).join(',\n');

  return `"""
Workflow: ${title}
Approach: 4. LangGraph
Examples: Graph/State-based agents
Best for: Complex production agents, stateful cycles, human-in-the-loop
"""

import os
from typing import TypedDict, Dict, Any
from langgraph.graph import StateGraph, START, END
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage

llm = ChatOpenAI(
    model="gpt-4o-mini",
    temperature=0.2,
    api_key=os.environ.get("OPENAI_API_KEY", "your-api-key")
)

class WorkflowState(TypedDict, total=False):
${stateTypeEntries}
    messages: list

${nodeFunctions}

def create_workflow_graph():
    builder = StateGraph(WorkflowState)

${addNodes}

    builder.add_edge(START, "${orderedNodes[0]?.varName || 'start'}")
${addEdges}

    return builder.compile()

if __name__ == "__main__":
    app = create_workflow_graph()
    initial_state: WorkflowState = {
${stateInitEntries},
        "messages": []
    }
    
    print("Running LangGraph workflow...")
    for output in app.stream(initial_state):
        for node_name, state_update in output.items():
            print(f"--- Node '{node_name}' Finished ---")
            print(state_update)
            print()
`;
}

// -------------------------------------------------------------
// 5. OPENAI AGENTS SDK
// -------------------------------------------------------------
function generateOpenAIAgents(ctx: WorkflowExportContext): string {
  const { orderedNodes } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent OpenAI Agents Workflow';

  const prompts = orderedNodes
    .map((node) => {
      return `AGENT_${node.varName.toUpperCase()}_PROMPT = """
You are a specialist agent for: ${node.label}
Objective: ${escapePyString(node.description)}
Expected output fields: ${node.outputKeys.join(', ') || 'result'}
""".strip()`;
    })
    .join('\n\n');

  const runMethods = orderedNodes
    .map((node, idx) => {
      return `    def run_${node.varName}(self, state_input: dict) -> dict:
        print(f"[Agent ${idx + 1}] Invoking ${node.label}...")
        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": AGENT_${node.varName.toUpperCase()}_PROMPT},
                {"role": "user", "content": f"Context: {state_input}"}
            ]
        )
        output_text = completion.choices[0].message.content or ""
        return {
            "${node.outputKeys[0] || 'result'}": output_text
        }`;
    })
    .join('\n\n');

  const kickoffSteps = orderedNodes
    .map(
      (node) =>
        `        res_${node.varName} = self.run_${node.varName}(self.context)\n        self.context.update(res_${node.varName})`,
    )
    .join('\n');

  return `"""
Workflow: ${title}
Approach: 5. OpenAI Agents SDK
Examples: Agents + tools + handoffs
Best for: OpenAI-based agent systems, lightweight multi-agent delegation
"""

import os
from openai import OpenAI

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", "your-api-key"))

${prompts}

class MultiAgentWorkflowRunner:
    def __init__(self):
        self.context = {}

${runMethods}

    def kickoff(self, user_goal: str) -> dict:
        self.context = {"goal": user_goal}
        
${kickoffSteps}
        return self.context

if __name__ == "__main__":
    runner = MultiAgentWorkflowRunner()
    final_output = runner.kickoff("${escapePyString(ctx.prompt || 'Start automation')}")
    import json
    print("\\n=== Workflow Complete ===")
    print(json.dumps(final_output, indent=2))
`;
}

// -------------------------------------------------------------
// 6. CREWAI
// -------------------------------------------------------------
function generateCrewAI(ctx: WorkflowExportContext): string {
  const { orderedNodes } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent CrewAI Workflow';

  const toolsDef = orderedNodes
    .filter((n) => n.toolId)
    .map((n) => {
      const fnName = `${sanitizeIdentifier(n.toolId || 'tool')}_${sanitizeIdentifier(n.toolAction || 'action')}`;
      return `@tool
def ${fnName}(argument: str) -> str:
    """Tool for ${n.label}: ${escapePyString(n.description)}"""
    return f"Completed ${n.label} with {argument}"`;
    })
    .join('\n\n');

  const agentsDef = orderedNodes
    .map((node) => {
      return `agent_${node.varName} = Agent(
    role="${node.label} Specialist",
    goal="${escapePyString(node.description)}",
    backstory="You are an expert autonomous agent specializing in ${node.label.toLowerCase()}.",
    verbose=True,
    memory=True
)`;
    })
    .join('\n\n');

  const tasksDef = orderedNodes
    .map((node) => {
      return `task_${node.varName} = Task(
    description=(
        "Execute ${node.label}.\\n"
        "Details: ${escapePyString(node.description)}\\n"
        "Inputs required: ${node.inputKeys.join(', ') || 'Initial prompt'}"
    ),
    expected_output="Structured summary containing: ${node.outputKeys.join(', ') || 'task outcome'}",
    agent=agent_${node.varName}
)`;
    })
    .join('\n\n');

  const agentList = orderedNodes.map((n) => `        agent_${n.varName}`).join(',\n');
  const taskList = orderedNodes.map((n) => `        task_${n.varName}`).join(',\n');

  return `"""
Workflow: ${title}
Approach: 6. CrewAI
Examples: Agents + Tasks + Crews
Best for: Multi-agent collaborative workflows with defined roles and goals
"""

import os
from crewai import Agent, Task, Crew, Process
from crewai.tools import tool

${toolsDef}

${agentsDef}

${tasksDef}

crew = Crew(
    agents=[
${agentList}
    ],
    tasks=[
${taskList}
    ],
    process=Process.sequential,
    verbose=True
)

if __name__ == "__main__":
    inputs = {
        "user_request": "${escapePyString(ctx.prompt || 'Start automation')}"
    }
    print("Starting CrewAI execution...")
    result = crew.kickoff(inputs=inputs)
    print("\\n=== Final Crew Result ===")
    print(result)
`;
}

// -------------------------------------------------------------
// 7. AUTOGEN
// -------------------------------------------------------------
function generateAutoGen(ctx: WorkflowExportContext): string {
  const { orderedNodes } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent AutoGen Workflow';

  const agentsDef = orderedNodes
    .map((node) => {
      return `agent_${node.varName} = autogen.AssistantAgent(
    name="${node.varName.replace(/[^a-zA-Z0-9_]/g, '')}",
    system_message=(
        "You are the specialist agent for: ${node.label}.\\n"
        "Goal: ${escapePyString(node.description)}\\n"
        "Produce outputs for: ${node.outputKeys.join(', ') || 'result'}.\\n"
        "When complete, pass relevant context to the next stage."
    ),
    llm_config=llm_config
)`;
    })
    .join('\n\n');

  const agentList = orderedNodes.map((n) => `        agent_${n.varName}`).join(',\n');
  const stepList = orderedNodes.map((n, i) => `${i + 1}. ${n.label}`).join('\\n');

  return `"""
Workflow: ${title}
Approach: 7. AutoGen (Microsoft)
Examples: ConversableAgent / AssistantAgent / GroupChat
Best for: Multi-agent conversations, code interpretation, cooperative solving
"""

import os
import autogen

llm_config = {
    "config_list": [{
        "model": "gpt-4o-mini",
        "api_key": os.environ.get("OPENAI_API_KEY", "your-api-key")
    }],
    "temperature": 0.2
}

user_proxy = autogen.UserProxyAgent(
    name="Admin",
    system_message="A human admin managing the workflow.",
    code_execution_config=False,
    human_input_mode="NEVER"
)

${agentsDef}

groupchat = autogen.GroupChat(
    agents=[
        user_proxy,
${agentList}
    ],
    messages=[],
    max_round=${Math.max(orderedNodes.length * 2, 6)},
    speaker_selection_method="round_robin"
)

manager = autogen.GroupChatManager(groupchat=groupchat, llm_config=llm_config)

if __name__ == "__main__":
    initial_message = (
        "Workflow Objective: ${escapePyString(ctx.prompt || title)}\\n"
        "Please execute the steps in order:\\n"
        "${stepList}"
    )

    print("Initiating AutoGen Multi-Agent Conversation...")
    user_proxy.initiate_chat(
        manager,
        message=initial_message
    )
`;
}

// -------------------------------------------------------------
// 8. LLAMAINDEX
// -------------------------------------------------------------
function generateLlamaIndex(ctx: WorkflowExportContext): string {
  const { orderedNodes } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent LlamaIndex Workflow';

  const eventsDef = orderedNodes
    .map((node) => {
      const clsName = node.varName.charAt(0).toUpperCase() + node.varName.slice(1) + 'Event';
      return `class ${clsName}(Event):
    payload: Dict[str, Any]`;
    })
    .join('\n\n');

  const stepMethods = orderedNodes
    .map((node, idx) => {
      const currentEventClass =
        node.varName.charAt(0).toUpperCase() + node.varName.slice(1) + 'Event';
      const isLast = idx === orderedNodes.length - 1;
      const nextEventClass = isLast
        ? 'StopEvent'
        : orderedNodes[idx + 1].varName.charAt(0).toUpperCase() +
          orderedNodes[idx + 1].varName.slice(1) +
          'Event';

      const retStatement = isLast
        ? 'return StopEvent(result=updated_payload)'
        : `return ${nextEventClass}(payload=updated_payload)`;

      return `    @step
    async def step_${node.varName}(self, ev: ${currentEventClass}, ctx: Context) -> ${nextEventClass}:
        print(f"LlamaIndex step: ${node.label}")
        data = ev.payload
        prompt = (
            f"Step: ${node.label}\\n"
            f"Description: ${escapePyString(node.description)}\\n"
            f"Context: {data}\\n"
            "Provide output keys: ${node.outputKeys.join(', ') || 'result'}"
        )
        response = await self.llm.acomplete(prompt)
        updated_payload = {**data, "${node.outputKeys[0] || 'result'}": str(response)}
        ${retStatement}`;
    })
    .join('\n\n');

  const firstEventClass =
    (orderedNodes[0]?.varName || 'start').charAt(0).toUpperCase() +
    (orderedNodes[0]?.varName || 'start').slice(1) +
    'Event';
  const wfClassName =
    sanitizeIdentifier(title).replace(/(^|_)([a-z])/g, (_full, _sep, b) => b.toUpperCase()) +
    'Workflow';

  return `"""
Workflow: ${title}
Approach: 8. LlamaIndex
Examples: LlamaIndex Workflows (Event-driven)
Best for: Data/document-heavy agents, RAG, knowledge graph pipelines
"""

import asyncio
from typing import Any, Dict
from llama_index.core.workflow import (
    Workflow,
    Event,
    StartEvent,
    StopEvent,
    step,
    Context
)
from llama_index.llms.openai import OpenAI

${eventsDef}

class ${wfClassName}(Workflow):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.llm = OpenAI(model="gpt-4o-mini")

    @step
    async def step_start(self, ev: StartEvent) -> ${firstEventClass}:
        print("Starting LlamaIndex Workflow...")
        initial_data = ev.get("input", "${escapePyString(ctx.prompt || 'Start')}")
        return ${firstEventClass}(payload={"request": initial_data})

${stepMethods}

async def main():
    wf = ${wfClassName}(timeout=60, verbose=True)
    result = await wf.run(input="${escapePyString(ctx.prompt || 'Execute automation')}")
    print("\\n=== Workflow Complete ===")
    print(result)

if __name__ == "__main__":
    asyncio.run(main())
`;
}

// -------------------------------------------------------------
// 9. SEMANTIC KERNEL
// -------------------------------------------------------------
function generateSemanticKernel(ctx: WorkflowExportContext): string {
  const { orderedNodes } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent Semantic Kernel Workflow';

  const pluginFunctions = orderedNodes
    .map((node) => {
      return `    @kernel_function(
        name="${node.varName}",
        description="${escapePyString(node.description)}"
    )
    def ${node.varName}(self, context: str) -> str:
        print(f"Executing Semantic Kernel plugin function: ${node.label}")
        return f"Completed ${node.label} step for context: {context[:60]}..."`;
    })
    .join('\n\n');

  const pipelineSteps = orderedNodes
    .map(
      (node) =>
        `    # Step: ${node.label}\n` +
        `    result_${node.varName} = await kernel.invoke(\n` +
        `        plugin["${node.varName}"],\n` +
        `        context=current_context\n` +
        `    )\n` +
        `    print(f"✓ ${node.label}: {result_${node.varName}}")\n` +
        `    current_context = str(result_${node.varName})`,
    )
    .join('\n\n');

  return `"""
Workflow: ${title}
Approach: 9. Semantic Kernel (Microsoft)
Examples: Semantic Kernel Python SDK
Best for: Microsoft ecosystem, enterprise AI applications, kernel plugins
"""

import asyncio
import os
from semantic_kernel import Kernel
from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion
from semantic_kernel.functions import kernel_function

class WorkflowPlugins:
${pluginFunctions}

async def main():
    kernel = Kernel()

    api_key = os.environ.get("OPENAI_API_KEY", "your-api-key")
    kernel.add_service(
        OpenAIChatCompletion(
            service_id="chat_completion",
            ai_model_id="gpt-4o-mini",
            api_key=api_key
        )
    )

    plugin = kernel.add_plugin(
        plugin=WorkflowPlugins(),
        plugin_name="AutoAgentWorkflow"
    )

    print("Running Semantic Kernel pipeline...")
    current_context = "${escapePyString(ctx.prompt || 'Start automation')}"

${pipelineSteps}

    print("\\n=== Workflow execution finished ===")

if __name__ == "__main__":
    asyncio.run(main())
`;
}

// -------------------------------------------------------------
// 10. CUSTOM AGENT FRAMEWORK
// -------------------------------------------------------------
function generateCustomAgent(ctx: WorkflowExportContext): string {
  const { orderedNodes, stateKeys } = parseWorkflow(ctx);
  const title = ctx.title || 'AutoAgent Custom Framework Workflow';

  const stepFunctions = orderedNodes
    .map((node) => {
      const ret =
        node.outputKeys.length > 0
          ? node.outputKeys.map((k) => `        "${k}": "${node.label} output"`).join(',\n')
          : '        "status": "success"';

      return `def step_${node.varName}(state: WorkflowState) -> Dict[str, Any]:
    # Description: ${escapePyString(node.description)}
    return {
${ret}
    }`;
    })
    .join('\n\n');

  const registerSteps = orderedNodes
    .map(
      (node) =>
        `    engine.add_step(WorkflowNode(\n` +
        `        id="${node.id}",\n` +
        `        name="${node.label}",\n` +
        `        action=step_${node.varName}\n` +
        `    ))`,
    )
    .join('\n');

  const stateInitEntries = stateKeys
    .map((k) => `        "${k}": "Initial value for ${k}"`)
    .join(',\n');

  return `"""
Workflow: ${title}
Approach: 10. Custom Agent Framework
Examples: Python + your own orchestration
Best for: Maximum control, zero vendor lock-in, minimal dependencies
"""

import json
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, Any, List

@dataclass
class WorkflowState:
    data: Dict[str, Any] = field(default_factory=dict)
    logs: List[str] = field(default_factory=list)

@dataclass
class WorkflowNode:
    id: str
    name: str
    action: Callable[[WorkflowState], Dict[str, Any]]
    retries: int = 2

class CustomWorkflowEngine:
    def __init__(self):
        self.nodes: List[WorkflowNode] = []
        self.state = WorkflowState()

    def add_step(self, node: WorkflowNode):
        self.nodes.append(node)

    def run(self, initial_data: Dict[str, Any] = None) -> WorkflowState:
        if initial_data:
            self.state.data.update(initial_data)

        print("=== EXECUTING CUSTOM AGENT ENGINE ===")
        for node in self.nodes:
            attempts = 0
            success = False
            while attempts <= node.retries and not success:
                try:
                    start_time = time.time()
                    print(f"Executing: [{node.name}] (attempt {attempts + 1})...")
                    output = node.action(self.state)
                    self.state.data.update(output)
                    duration = round((time.time() - start_time) * 1000, 2)
                    self.state.logs.append(f"✓ {node.name} completed in {duration}ms")
                    success = True
                except Exception as e:
                    attempts += 1
                    print(f"  Error in {node.name}: {e}")
                    if attempts > node.retries:
                        self.state.logs.append(f"✗ {node.name} failed: {e}")
                        raise

        print("=== WORKFLOW FINISHED ===")
        return self.state

${stepFunctions}

if __name__ == "__main__":
    engine = CustomWorkflowEngine()

${registerSteps}

    initial_payload = {
${stateInitEntries},
        "user_request": "${escapePyString(ctx.prompt || 'Start automation')}"
    }

    final_state = engine.run(initial_payload)
    print("\\nExecution Logs:")
    for log in final_state.logs:
        print(f"  {log}")
    print("\\nFinal State Data:")
    print(json.dumps(final_state.data, indent=2))
`;
}

// -------------------------------------------------------------
// EXPORT CATALOG OF THE 10 APPROACHES
// -------------------------------------------------------------
export const EXPORT_APPROACHES: ExportApproach[] = [
  {
    id: 'raw_llm',
    name: '1. Raw LLM API + Python',
    example: 'OpenAI / Gemini / Claude SDKs',
    bestFor: 'Learning fundamentals, simple agents',
    language: 'python',
    extension: 'py',
    pipInstall: 'pip install openai google-genai anthropic',
    envVars: ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY'],
    description:
      'Direct model calls using native Python SDKs without heavy framework overhead. Clean, transparent, and easy to debug.',
    generateCode: generateRawLLM,
  },
  {
    id: 'google_adk',
    name: '2. Google ADK',
    example: 'Gemini + ADK',
    bestFor: 'Google ecosystem, multi-agent systems',
    language: 'python',
    extension: 'py',
    pipInstall: 'pip install google-genai',
    envVars: ['GEMINI_API_KEY'],
    description:
      'Google Agent Development Kit and Gemini GenAI SDK with native tool calling, multimodal support, and Workspace integration.',
    generateCode: generateGoogleADK,
  },
  {
    id: 'langchain',
    name: '3. LangChain',
    example: 'LangChain + tools + RAG',
    bestFor: 'General GenAI applications',
    language: 'python',
    extension: 'py',
    pipInstall: 'pip install langchain langchain-openai langchain-core',
    envVars: ['OPENAI_API_KEY'],
    description:
      'Standard enterprise GenAI framework using LangChain Expression Language (LCEL), tool abstractions, and prompt templates.',
    generateCode: generateLangChain,
  },
  {
    id: 'langgraph',
    name: '4. LangGraph',
    example: 'Graph/state-based agents',
    bestFor: 'Complex production agents',
    language: 'python',
    extension: 'py',
    pipInstall: 'pip install langgraph langchain-openai langchain-core',
    envVars: ['OPENAI_API_KEY'],
    description:
      'Stateful, cyclical multi-agent graph runtime with checkpoints, human-in-the-loop gates, and deterministic step transitions.',
    generateCode: generateLangGraph,
  },
  {
    id: 'openai_agents',
    name: '5. OpenAI Agents SDK',
    example: 'Agents + tools + handoffs',
    bestFor: 'OpenAI-based agent systems',
    language: 'python',
    extension: 'py',
    pipInstall: 'pip install openai',
    envVars: ['OPENAI_API_KEY'],
    description:
      'OpenAI agent design with specialist agent routines, function calling, and dynamic handoffs between agents.',
    generateCode: generateOpenAIAgents,
  },
  {
    id: 'crewai',
    name: '6. CrewAI',
    example: 'Agents + tasks + crews',
    bestFor: 'Multi-agent workflows',
    language: 'python',
    extension: 'py',
    pipInstall: 'pip install crewai crewai-tools',
    envVars: ['OPENAI_API_KEY'],
    description:
      'Role-playing multi-agent architecture where autonomous agents collaborate sequentially or hierarchically on assigned tasks.',
    generateCode: generateCrewAI,
  },
  {
    id: 'autogen',
    name: '7. AutoGen',
    example: 'Microsoft AutoGen',
    bestFor: 'Multi-agent conversations',
    language: 'python',
    extension: 'py',
    pipInstall: 'pip install pyautogen',
    envVars: ['OPENAI_API_KEY'],
    description:
      'Microsoft conversational multi-agent framework featuring AssistantAgent, UserProxyAgent, and multi-agent group chats.',
    generateCode: generateAutoGen,
  },
  {
    id: 'llamaindex',
    name: '8. LlamaIndex',
    example: 'Agents + RAG + data',
    bestFor: 'Data/document-heavy agents',
    language: 'python',
    extension: 'py',
    pipInstall: 'pip install llama-index llama-index-core llama-index-llms-openai',
    envVars: ['OPENAI_API_KEY'],
    description:
      'Event-driven workflow system optimized for document processing, semantic retrieval, vector search, and structured data pipelines.',
    generateCode: generateLlamaIndex,
  },
  {
    id: 'semantic_kernel',
    name: '9. Semantic Kernel',
    example: 'Microsoft ecosystem',
    bestFor: 'Enterprise AI applications',
    language: 'python',
    extension: 'py',
    pipInstall: 'pip install semantic-kernel',
    envVars: ['OPENAI_API_KEY'],
    description:
      'Microsoft enterprise SDK integrating LLMs with native code plugins, connectors, and enterprise orchestration pipelines.',
    generateCode: generateSemanticKernel,
  },
  {
    id: 'custom_agent',
    name: '10. Custom Agent Framework',
    example: 'Python + your own orchestration',
    bestFor: 'Maximum control',
    language: 'python',
    extension: 'py',
    pipInstall: '# No external frameworks required! Pure Python stdlib',
    envVars: [],
    description:
      'Pure Python orchestration with zero third-party agent dependencies. Complete control over memory, logging, retries, and state.',
    generateCode: generateCustomAgent,
  },
];

export function getExportApproach(id: string): ExportApproach | undefined {
  return EXPORT_APPROACHES.find((a) => a.id === id);
}

export function exportWorkflowCode(
  approachId: string,
  context: WorkflowExportContext,
): {
  approach: ExportApproach;
  filename: string;
  code: string;
} {
  const approach = getExportApproach(approachId) || EXPORT_APPROACHES[0];
  const safeTitle = sanitizeIdentifier(context.title || 'workflow');
  const filename = `${safeTitle}_${approach.id}.${approach.extension}`;
  const code = approach.generateCode(context);

  return {
    approach,
    filename,
    code,
  };
}
