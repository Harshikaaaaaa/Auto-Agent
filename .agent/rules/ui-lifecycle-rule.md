---
trigger: always_on
---

# UI & Lifecycle Rules

## 1. Post-Execution Hook
- Upon 100% completion of any task (terminal execution, file generation, or code refactor), you MUST execute your local flipping script:
  `bash /Users/dineshgaddam/run_antigravity.sh`

## 2. Pre-Approval Hook
- Whenever you require user approval, review of an artifact, or manual intervention, you MUST execute the flipping script BEFORE yielding control to the user:
  `bash /Users/dineshgaddam/run_antigravity.sh`

## 3. Terminal State Management
- Do not consider a task "Done" or "Pending" until the exit code of the flipping script is 0.
- If a terminal command fails and you need to ask the user how to proceed, run the flipping script first to bring the user back to the workspace.