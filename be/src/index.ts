require("dotenv").config();
import express from "express";
import { GoogleGenAI } from "@google/genai";
import { BASE_PROMPT, getSystemPrompt } from "./prompts";
import { basePrompt as nodeBasePrompt } from "./defaults/node";
import { basePrompt as reactBasePrompt } from "./defaults/react";
import cors from "cors";
import { Octokit } from "@octokit/rest";

if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing");
}

if (!process.env.GITHUB_TOKEN) {
  throw new Error("GITHUB_TOKEN is missing");
}

// ✅ NEW SDK
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const app = express();
app.use(cors());
app.use(express.json());

app.post("/template", async(req: any, res: any) => {
    const prompt = req.body.prompt;
    console.log(prompt)

    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
            systemInstruction:
                "Return either node or react based on what do you think this project should be. Only return a single word either 'node' or 'react'. Do not return anything extra",
        },
    });

    const answer = response.text!.trim().toLowerCase(); // react or node
    console.log(answer)

    if (answer === "react") {
        return res.json({
            prompts: [
                BASE_PROMPT,
                `Here is an artifact that contains all files of the project visible to you.\nConsider the contents of ALL files in the project.\n\n${reactBasePrompt}\n\nHere is a list of files that exist on the file system but are not being shown to you:\n\n  - .gitignore\n  - package-lock.json\n`,
            ],
            uiPrompts: [reactBasePrompt],
        });
    }

    if (answer === "node") {
        return res.json({
            prompts: [
                `Here is an artifact that contains all files of the project visible to you.\nConsider the contents of ALL files in the project.\n\n${nodeBasePrompt}\n\nHere is a list of files that exist on the file system but are not being shown to you:\n\n  - .gitignore\n  - package-lock.json\n`,
            ],
            uiPrompts: [nodeBasePrompt],
        });
    }

    return res.status(403).json({ message: "You cant access this" });
});

app.post("/chat", async (req, res) => {
    const messages = req.body.messages;

    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: messages.map((m: any) => m.content).join("\n"),
        config: {
            systemInstruction: getSystemPrompt(),
        },
    });

    console.log(response);
    console.log(response.text)
    res.json({
        response: response.text,
    });
});

app.post("/deploy", async (req: any, res: any) => {
  const files = req.body.files as Record<string, { code: string }>;

  if (!files || typeof files !== "object") {
    return res.status(400).json({ error: "Invalid files" });
  }

  const repoName = `ai-app-${Date.now()}`;

  try {
    // 1. Create repo
    const { data: repo } =
      await octokit.repos.createForAuthenticatedUser({
        name: repoName,
        private: false,
      });
    
      console.log("Repo created:", repo.html_url);

    const owner = repo.owner.login;

    // ⏳ wait 2 seconds (critical)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 2. Upload files one by one
    for (const [path, file] of Object.entries(files)) {
      if (!file?.code) continue;

      const cleanPath = path.replace(/\\/g, "/");

      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo: repoName,
        path: cleanPath,
        message: "initial commit",
        content: Buffer.from(file.code).toString("base64"),
      });
    }

    return res.json({
      repoUrl: repo.html_url,
    });

  } catch (err) {
    console.error("DEPLOY ERROR:", err);
    return res.status(500).json({ error: "Deploy failed" });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on PORT ${PORT}`));