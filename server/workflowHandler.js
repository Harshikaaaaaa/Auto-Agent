import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure workflows file exists
if (!fs.existsSync(WORKFLOWS_FILE)) {
    fs.writeFileSync(WORKFLOWS_FILE, '[]', 'utf8');
}

export function setupWorkflowRoutes(app) {
    // GET /workflows
    app.get('/workflows', (req, res) => {
        try {
            const data = fs.readFileSync(WORKFLOWS_FILE, 'utf8');
            const workflows = JSON.parse(data);
            res.json(workflows);
        } catch (error) {
            console.error('Error reading workflows:', error);
            res.status(500).json({ error: 'Failed to read workflows' });
        }
    });

    // POST /workflows
    app.post('/workflows', (req, res) => {
        try {
            const workflow = req.body;
            if (!workflow.name) {
                return res.status(400).json({ error: 'Workflow name is required' });
            }

            const data = fs.readFileSync(WORKFLOWS_FILE, 'utf8');
            let workflows = JSON.parse(data);

            // Update if exists, otherwise append
            const idx = workflows.findIndex(w => w.name === workflow.name);
            const entry = {
                ...workflow,
                savedAt: new Date().toISOString()
            };

            if (idx >= 0) {
                workflows[idx] = entry;
            } else {
                workflows.push(entry);
            }

            fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(workflows, null, 2), 'utf8');
            res.json({ success: true, workflow: entry });
        } catch (error) {
            console.error('Error saving workflow:', error);
            res.status(500).json({ error: 'Failed to save workflow' });
        }
    });

    // DELETE /workflows/:name
    app.delete('/workflows/:name', (req, res) => {
        try {
            const { name } = req.params;
            const data = fs.readFileSync(WORKFLOWS_FILE, 'utf8');
            let workflows = JSON.parse(data);

            const initialLength = workflows.length;
            workflows = workflows.filter(w => w.name !== name);

            if (workflows.length === initialLength) {
                return res.status(404).json({ error: 'Workflow not found' });
            }

            fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(workflows, null, 2), 'utf8');
            res.json({ success: true });
        } catch (error) {
            console.error('Error deleting workflow:', error);
            res.status(500).json({ error: 'Failed to delete workflow' });
        }
    });
}
