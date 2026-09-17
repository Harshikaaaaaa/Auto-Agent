# Quick Fix Guide - Gemini API Model Name Issue

## The Problem
Workflow generation fails with 404 error because the model name in the code doesn't match what the Gemini API expects.

## Where to Fix
File: `src/features/ai/services/geminiService.ts`

Lines to update: **30, 180, 205, 219**

## Current (Broken) Code
```typescript
model: 'gemini-1.5-flash-latest'  // ❌ Returns 404
```

## Possible Solutions to Try

### Option 1: Check Your API Key's Model Access
```bash
# Visit Google AI Studio
https://aistudio.google.com/

# Check which models your API key has access to
# Copy the exact model identifier shown there
```

### Option 2: Try These Model Names
Replace the model name with one of these (try in order):

1. `'gemini-1.5-pro'` - Stable Pro model
2. `'gemini-1.5-flash'` - Stable Flash model  
3. `'gemini-pro'` - Legacy Pro model
4. `'models/gemini-1.5-flash'` - With models/ prefix
5. `'models/gemini-1.5-pro'` - With models/ prefix

### Option 3: Check Package Documentation
```bash
# Check the @google/genai package docs
npm info @google/genai

# Or visit
https://www.npmjs.com/package/@google/genai
```

## How to Apply the Fix

### Step 1: Edit the File
Open `src/features/ai/services/geminiService.ts` and find these 4 locations:

**Location 1 (Line ~30):**
```typescript
const response = await ai.models.generateContent({
    model: 'YOUR_MODEL_NAME_HERE',  // ← Change this
    contents: `You are an expert...`
});
```

**Location 2 (Line ~180):**
```typescript
const response = await ai.models.generateContent({
    model: 'YOUR_MODEL_NAME_HERE',  // ← Change this
    contents: prompt,
    config: {
        tools: [{ functionDeclarations }]
    }
});
```

**Location 3 (Line ~205):**
```typescript
const finalResponse = await ai.models.generateContent({
    model: 'YOUR_MODEL_NAME_HERE',  // ← Change this
    contents: finalPrompt
});
```

**Location 4 (Line ~219):**
```typescript
const response = await ai.models.generateContent({
    model: 'YOUR_MODEL_NAME_HERE',  // ← Change this
    contents: prompt
});
```

### Step 2: Rebuild
```bash
npm run build
```

### Step 3: Hard Refresh Browser
Press `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows/Linux)

### Step 4: Test
Try generating a workflow with: "Send an email with sales data"

## Verification

If the fix works, you should see:
- ✅ Nodes appear on the canvas
- ✅ No 404 errors in console
- ✅ Workflow generates successfully

If it still fails:
- ❌ Check console for new error message
- ❌ Try next model name from the list
- ❌ Verify API key is correct in `.env.local`

## Alternative: Use a Different SDK

If none of the model names work, consider switching to the official Google AI SDK:

```bash
npm install @google/generative-ai
```

Then update the import and initialization in `geminiService.ts`.

## Need Help?

1. Check browser console for exact error message
2. Verify API key in `.env.local` file
3. Test API key in Google AI Studio
4. Check if there are any API quota limits
