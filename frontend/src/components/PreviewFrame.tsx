import { WebContainer } from '@webcontainer/api';
import React, { useEffect, useState } from 'react';

interface PreviewFrameProps {
  webContainer: WebContainer;
}

export function PreviewFrame({ webContainer }: PreviewFrameProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!webContainer || started) return;

    async function startDev() {
      try {
        console.log("📦 Starting package installation...");

        // ✅ INSTALL PACKAGES (with logs)
        const installProcess = await webContainer.spawn('npm', ['install']);

        installProcess.output.pipeTo(
          new WritableStream({
            write(data) {
              const text = data.toString();
              console.log(text);

              if (text.includes("added") || text.includes("installed")) {
                console.log("📦 Packages installed:", text);
              } else if (text.includes("up to date")) {
                console.log("✅ Packages already up to date");
              } else if (
                text.toLowerCase().includes("error") ||
                text.includes("ERR")
              ) {
                console.error("❌ Install Error:", text);
                setError(text);
              } else {
                console.log("📥 Installing:", text);
              }
            },
          })
        );

        await installProcess.exit;

        console.log("🚀 Starting dev server...");

        // ✅ START DEV SERVER
        const devProcess = await webContainer.spawn('npm', ['run', 'dev']);

        devProcess.output.pipeTo(
          new WritableStream({
            write(data) {
              const text = data.toString();
              console.log(text);

              if (text.includes("Local:") || text.includes("localhost")) {
                console.log("🚀 Dev server started");
              } else if (text.toLowerCase().includes("error")) {
                console.error("❌ Dev Error:", text);
                setError(text);
              } else {
                console.log("🖥️ Dev:", text);
              }
            },
          })
        );

        // ✅ SERVER READY
        webContainer.on('server-ready', (port, url) => {
          console.log("🌐 Preview URL:", url);
          setUrl(url);
        });

        setStarted(true);
      } catch (err: any) {
        console.error("❌ Preview failed:", err);
        setError("Failed to start preview");
      }
    }

    startDev();
  }, [webContainer, started]);

  return (
    <div className="h-full flex items-center justify-center text-gray-400">
      {!url && !error && (
        <div className="text-center">
          <p className="mb-2">📦 Installing & starting preview...</p>
        </div>
      )}

      {error && (
        <div className="text-red-500 p-4 text-sm">
          ⚠️ Preview Error:
          <pre className="mt-2 whitespace-pre-wrap">{error}</pre>
        </div>
      )}

      {url && !error && (
        <iframe
          width="100%"
          height="100%"
          src={url}
          className="border-none"
        />
      )}
    </div>
  );
}