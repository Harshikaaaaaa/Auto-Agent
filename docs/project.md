# AutoAgent

AutoAgent is a high-fidelity, AI-powered automation workflow builder designed for speed and scalability. It allows users to design, orchestrate, and execute complex workflows through natural language prompts and a specialized skill-based node system.

## 🚀 Key Features

- **Magic Workflow Generation**: Simply describe your goal (e.g., "Analyze CSV sales data and email a report"), and the AI agent will design the entire workflow for you.
- **Custom Node Skills System**: A library of 20+ specialized skills across several categories:
  - **Data**: CSV Parser, JSON Transformer, Data Validator.
  - **Communication**: Email Sender, Slack Notifier, SMS Sender.
  - **AI**: Text Analyzer, Image Analyzer, Content Generator.
  - **Documents**: PDF Generator, Spreadsheet Creator, Report Builder.
  - **Automation & Integration**: Scheduler, Webhook Handler, API Caller, Database Connector.
- **AI-Powered Execution**: Each node uses Gemini AI with specialized system prompts to perform its specific task with high accuracy.
- **Real-time Execution Monitor**: Track progress, view logs, and download outputs from each step of the workflow.
- **Modern UI/UX**: Professional dark-themed interface built for a "wow" first impression.

## 🏗 Architecture

The project follows a **Feature-Based Architecture**, ensuring modularity and clean separation of concerns.

```text
auto-agent/
├── src/
│   ├── app/                # Application entry points and global styles
│   ├── features/           # Domain-specific logic
│   │   ├── workflow/       # ReactFlow hooks, components, and skill definitions
│   │   └── ai/             # AI service integrations (Gemini)
│   ├── shared/             # Common types, components, and utilities
│   ├── config/             # App-wide constants and skill configurations
│   └── assets/             # Static assets
└── vite.config.ts          # Path aliases for cleaner imports
```

## 🛠 Tech Stack

- **Frontend**: React 18, TypeScript, Lucide React
- **Flow Engine**: ReactFlow (v11)
- **AI Service**: Google Gemini API (@google/genai)
- **Build Tool**: Vite
- **Styling**: Vanilla CSS (Modern aesthetic)

## 🚦 Getting Started

### Prerequisites

- Node.js installed on your system.
- A Gemini API Key from [Google AI Studio](https://aistudio.google.com/).

### Installation

1. Clone the repository and navigate to the project directory.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set your API key in `.env.local`:
   ```text
   GEMINI_API_KEY=your_api_key_here
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```

## 🧩 Adding New Skills

The skill system is highly extensible. New skills can be added by registering them in `src/features/workflow/skills/skillRegistry.ts`. Each skill requires:
- `id`: Unique identifier.
- `name`: Display name.
- `category`: Functional category.
- `description`: Purpose of the skill.
- `capabilities`: Specific actions the skill can perform.
- `icon`: Lucide icon name.
- `color`: Visual brand color.
- `systemPrompt`: Instruction for the AI model during execution.

---
*Created by Antigravity AI*
