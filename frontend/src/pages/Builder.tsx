import React, { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { StepsList } from "../components/StepsList";
import { FileExplorer } from "../components/FileExplorer";
import { TabView } from "../components/TabView";
import { CodeEditor } from "../components/CodeEditor";
import { PreviewFrame } from "../components/PreviewFrame";
import { Step, FileItem, StepType } from "../types";
import axios from "axios";
import { BACKEND_URL } from "../config";
import { parseXml } from "../steps";
import { useWebContainer } from "../hooks/useWebContainer";
import { FileNode } from "@webcontainer/api";
import { Loader } from "../components/Loader";
import JSZip from "jszip";
import { saveAs } from "file-saver";

const extractDependencies = (code: string): string[] => {
  const matches = [
    ...(code.match(/from\s+["']([^"']+)["']/g) || []),
    ...(code.match(/import\s+["']([^"']+)["']/g) || []),
  ];

  return matches
    .map((m) => m.replace(/(from|import)\s+["']|["']/g, ""))
    .filter((dep) => !dep.startsWith(".") && !dep.startsWith("/"));
};

const updatePackageJson = (
  files: FileItem[],
  newDeps: string[],
): FileItem[] => {
  return files.map((file) => {
    if (file.name === "package.json" && file.type === "file") {
      try {
        const parsed = JSON.parse(file.content || "{}");

        parsed.dependencies = parsed.dependencies || {};

        newDeps.forEach((dep) => {
          if (!parsed.dependencies[dep]) {
            parsed.dependencies[dep] = "latest";
          }
        });

        return {
          ...file,
          content: JSON.stringify(parsed, null, 2),
        };
      } catch {
        return file;
      }
    }

    return file;
  });
};

const fixReactImport = (code: string, filePath: string) => {
  const isReactFile = filePath.endsWith(".jsx") || filePath.endsWith(".tsx");

  if (!isReactFile) return code;

  // detect JSX usage (simple but effective)
  const usesJSX = /return\s*\(?.*</.test(code);

  const hasReactImport = /from\s+["']react["']/.test(code);

  if (usesJSX && !hasReactImport) {
    return `import React from "react";\n${code}`;
  }

  return code;
};

const MOCK_FILE_CONTENT = `// This is a sample file content
import React from 'react';

function Component() {
  return <div>Hello World</div>;
}

export default Component;`;

export function Builder() {
  const [lastDeps, setLastDeps] = useState<string[]>([]);
  const location = useLocation();
  const { prompt } = location.state as { prompt: string };
  const [userPrompt, setPrompt] = useState("");
  const [llmMessages, setLlmMessages] = useState<
    { role: "user" | "assistant"; content: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [templateSet, setTemplateSet] = useState(false);
  const webcontainer = useWebContainer();

  const [currentStep, setCurrentStep] = useState(1);
  const [activeTab, setActiveTab] = useState<"code" | "preview">("code");
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);

  const [steps, setSteps] = useState<Step[]>([]);

  const [files, setFiles] = useState<FileItem[]>([]);

  useEffect(() => {
    let originalFiles = [...files];
    let updateHappened = false;
    let collectedDeps = new Set<string>();

    steps
      .filter(({ status }) => status === "pending")
      .forEach((step) => {
        updateHappened = true;

        if (step?.type === StepType.CreateFile) {
          let parsedPath = step.path?.split("/") ?? [];
          let currentFileStructure = [...originalFiles];
          let finalAnswerRef = currentFileStructure;

          let currentFolder = "";

          while (parsedPath.length) {
            currentFolder = `${currentFolder}/${parsedPath[0]}`;
            let currentFolderName = parsedPath[0];
            parsedPath = parsedPath.slice(1);

            if (!parsedPath.length) {
              let file = currentFileStructure.find(
                (x) => x.path === currentFolder,
              );

              const code = step.code || "";

              // ✅ extract dependencies ONCE
              const deps = extractDependencies(code);
              deps.forEach((dep) => {
                const baseDep = dep.startsWith("@")
                  ? dep.split("/").slice(0, 2).join("/") // scoped packages
                  : dep.split("/")[0]; // normal packages

                collectedDeps.add(baseDep);
              });

              if (!file) {
                currentFileStructure.push({
                  name: currentFolderName,
                  type: "file",
                  path: currentFolder,
                  content: fixReactImport(code, currentFolder),
                });
              } else {
                file.content = fixReactImport(code, currentFolder);
              }
            } else {
              let folder = currentFileStructure.find(
                (x) => x.path === currentFolder,
              );

              if (!folder) {
                folder = {
                  name: currentFolderName,
                  type: "folder",
                  path: currentFolder,
                  children: [],
                };
                currentFileStructure.push(folder);
              }

              currentFileStructure = folder.children!;
            }
          }

          originalFiles = finalAnswerRef;
        }
      });

    if (updateHappened) {
      // 👉 update package.json here
      originalFiles = updatePackageJson(
        originalFiles,
        Array.from(collectedDeps),
      );

      setFiles(originalFiles);

      setSteps((steps) =>
        steps.map((s) =>
          s.status === "pending" ? { ...s, status: "completed" } : s,
        ),
      );
    }
  }, [steps]); // ✅ FIXED (removed files)

  useEffect(() => {
    const run = async () => {
      if (!files.length || !webcontainer) return;

      const packageFile = files.find(
        (f) => f.name === "package.json" && f.type === "file",
      );

      let currentDeps: string[] = [];

      if (packageFile) {
        try {
          const parsed = JSON.parse(packageFile.content || "{}");
          currentDeps = Object.keys(parsed.dependencies || {});
        } catch {}
      }

      const depsChanged =
        JSON.stringify([...currentDeps].sort()) !==
        JSON.stringify([...lastDeps].sort());

      const createMountStructure = (files: FileItem[]): Record<string, any> => {
        const mountStructure: Record<string, any> = {};

        const processFile = (file: FileItem, isRootFolder: boolean) => {
          if (file.type === "folder") {
            mountStructure[file.name] = {
              directory: file.children
                ? Object.fromEntries(
                    file.children.map((child) => [
                      child.name,
                      processFile(child, false),
                    ]),
                  )
                : {},
            };
          } else if (file.type === "file") {
            if (isRootFolder) {
              mountStructure[file.name] = {
                file: {
                  contents: file.content || "",
                },
              };
            } else {
              return {
                file: {
                  contents: file.content || "",
                },
              };
            }
          }

          return mountStructure[file.name];
        };

        files.forEach((file) => processFile(file, true));

        return mountStructure;
      };

      const mountStructure = createMountStructure(files);

      console.log("Mounting files:", mountStructure);

      webcontainer.mount(mountStructure);
      if (depsChanged) {
        console.log("Dependencies changed → reinstalling...");

        await webcontainer.spawn("npm", ["install"]);

        setLastDeps(currentDeps);
      }
    };
    run();
  }, [files, webcontainer]);

  async function init() {
    const response = await axios.post(`${BACKEND_URL}/template`, {
      prompt: prompt.trim(),
    });
    setTemplateSet(true);

    const { prompts, uiPrompts } = response.data;

    // setSteps(parseXml(uiPrompts[0]).map((x: Step) => ({
    //   ...x,
    //   status: "pending"
    // })));
    setSteps(
      parseXml(uiPrompts[0]).map((x: Step) => ({
        ...x,
        id: crypto.randomUUID(), // ✅ FIX
        status: "pending" as const,
      })),
    );

    setLoading(true);
    const stepsResponse = await axios.post(`${BACKEND_URL}/chat`, {
      messages: [...prompts, prompt].map((content) => ({
        role: "user",
        content,
      })),
    });

    setLoading(false);

    // setSteps(s => [...s, ...parseXml(stepsResponse.data.response).map(x => ({
    //   ...x,
    //   status: "pending" as "pending"
    // }))]);

    setSteps((s) => [
      ...s,
      ...parseXml(stepsResponse.data.response).map((x) => ({
        ...x,
        id: crypto.randomUUID(), // ✅ FIX
        status: "pending" as const,
      })),
    ]);

    setLlmMessages(
      [...prompts, prompt].map((content) => ({
        role: "user",
        content,
      })),
    );

    setLlmMessages((x) => [
      ...x,
      { role: "assistant", content: stepsResponse.data.response },
    ]);
  }

  useEffect(() => {
    init();
  }, []);

  const downloadProject = async () => {
    if (!files.length) {
      alert("No project generated yet");
      return;
    }

    const zip = new JSZip();

    const addFiles = (items: FileItem[], folder: JSZip) => {
      items.forEach((item) => {
        if (item.type === "folder") {
          const newFolder = folder.folder(item.name);
          if (item.children && newFolder) {
            addFiles(item.children, newFolder);
          }
        } else {
          folder.file(item.name, item.content || "");
        }
      });
    };

    addFiles(files, zip);

    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, "text-to-app.zip");
  };

  const handleDeploy = async () => {
    try {
      if (!files.length) {
        alert("No project to deploy");
        return;
      }

      // 🔥 Convert your FileItem[] → backend format
      const convertFiles = (
        items: FileItem[],
        basePath = "",
      ): Record<string, { code: string }> => {
        let result: Record<string, { code: string }> = {};

        items.forEach((item) => {
          const currentPath = basePath ? `${basePath}/${item.name}` : item.name;

          if (item.type === "file") {
            result[currentPath] = { code: item.content || "" };
          } else if (item.type === "folder" && item.children) {
            Object.assign(result, convertFiles(item.children, currentPath));
          }
        });

        return result;
      };

      const formattedFiles = convertFiles(files);

      console.log("FILES BEING SENT:", formattedFiles); // keep this

      const res = await fetch(`${BACKEND_URL}/deploy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: formattedFiles }),
      });

      const data = await res.json();

      console.log("REPO URL:", data.repoUrl);

      // 🚀 Redirect to Vercel import
      window.open(`https://vercel.com/new/import?s=${data.repoUrl}`, "_blank");
    } catch (err) {
      console.error("Deploy failed:", err);
    }
  };
  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <header className="bg-gray-800/80 backdrop-blur border-b border-gray-700 px-6 py-4 flex items-center justify-between">
        {/* Left side */}
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold text-white tracking-tight">
            TEXT TO APP GENERATOR
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">{prompt}</p>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3">
          {/* Download Button */}
          <button
            onClick={downloadProject}
            className="text-sm bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 rounded-md transition shadow"
          >
            Download
          </button>

          {/* Deploy Button */}
          <button
            onClick={handleDeploy}
            className="text-sm bg-purple-500 hover:bg-purple-600 px-3 py-1.5 rounded-md transition shadow"
          >
            Deploy
          </button>

          {/* Status */}
          <span className="text-xs text-gray-400 border border-gray-600 px-2 py-1 rounded-md">
            Live Build
          </span>

          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <div className="h-full grid grid-cols-4 gap-6 p-6">
          <div className="col-span-1 space-y-6 h-full">
            <div>
              <div className="h-[70vh] overflow-hidden">
                <StepsList
                  steps={steps}
                  currentStep={currentStep}
                  onStepClick={setCurrentStep}
                />
              </div>
              <div>
                <div className="mt-3">
                  {(loading || !templateSet) && <Loader />}

                  {!(loading || !templateSet) && (
                    <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2">
                      <textarea
                        value={userPrompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="Type your message..."
                        rows={2}
                        className="flex-1 bg-transparent text-gray-200 placeholder-gray-500 outline-none resize-none px-2 py-2 min-h-[60px] overflow-hidden"
                      />

                      <button
                        onClick={async () => {
                          const newMessage = {
                            role: "user" as "user",
                            content: userPrompt,
                          };

                          setLoading(true);
                          const stepsResponse = await axios.post(
                            `${BACKEND_URL}/chat`,
                            {
                              messages: [...llmMessages, newMessage],
                            },
                          );
                          setLoading(false);

                          setLlmMessages((x) => [...x, newMessage]);
                          setLlmMessages((x) => [
                            ...x,
                            {
                              role: "assistant",
                              content: stepsResponse.data.response,
                            },
                          ]);

                          setSteps((s) => [
                            ...s,
                            ...parseXml(stepsResponse.data.response).map(
                              (x) => ({
                                ...x,
                                id: crypto.randomUUID(),
                                status: "pending" as const,
                              }),
                            ),
                          ]);
                        }}
                        className="bg-purple-500 hover:bg-purple-600 text-white px-4 py-1.5 rounded-md transition"
                      >
                        Send
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="col-span-1">
            <FileExplorer files={files} onFileSelect={setSelectedFile} />
          </div>
          <div className="col-span-2 bg-gray-900 rounded-lg shadow-lg p-4 h-[calc(100vh-8rem)]">
            <TabView activeTab={activeTab} onTabChange={setActiveTab} />
            <div className="h-[calc(100%-4rem)]">
              {activeTab === "code" ? (
                <CodeEditor file={selectedFile} />
              ) : (
                <PreviewFrame webContainer={webcontainer} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
