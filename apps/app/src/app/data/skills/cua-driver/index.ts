/** Upstream Cua Driver skill pack (see NOTICE.md), bundled for workspace install. */
import skill from "./SKILL.md?raw";
import browser from "./BROWSER.md?raw";
import embedding from "./EMBEDDING.md?raw";
import license from "./LICENSE.md?raw";
import linux from "./LINUX.md?raw";
import macos from "./MACOS.md?raw";
import notice from "./NOTICE.md?raw";
import readme from "./README.md?raw";
import recording from "./RECORDING.md?raw";
import runtime from "./RUNTIME.md?raw";
import visual from "./VISUAL.md?raw";
import windows from "./WINDOWS.md?raw";
import workflow from "./WORKFLOW.md?raw";

export const CUA_DRIVER_SKILL_NAME = "cua-driver";
export const CUA_DRIVER_SKILL_CONTENT = skill;

/** Reference guides SKILL.md links to, written next to it. */
export const CUA_DRIVER_SKILL_FILES: ReadonlyArray<{ path: string; content: string }> = [
  { path: "README.md", content: readme },
  { path: "WORKFLOW.md", content: workflow },
  { path: "RUNTIME.md", content: runtime },
  { path: "MACOS.md", content: macos },
  { path: "WINDOWS.md", content: windows },
  { path: "LINUX.md", content: linux },
  { path: "BROWSER.md", content: browser },
  { path: "RECORDING.md", content: recording },
  { path: "VISUAL.md", content: visual },
  { path: "EMBEDDING.md", content: embedding },
  { path: "LICENSE.md", content: license },
  { path: "NOTICE.md", content: notice },
];
