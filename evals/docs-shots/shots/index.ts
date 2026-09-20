import type { Shot } from "./shot.ts";
import { denOfflineGptWeb, denPluginDetail, denSkillEditor } from "./den-web.ts";
import {
  desktopTeamPromptCards,
  libraryAddMcpModal,
  libraryAdvancedSettings,
  libraryCreateSkillModal,
  librarySkills,
  skillCreatedCard,
} from "./desktop.ts";
import { offlinegptWebTab } from "./web-tab.ts";

export const shots: Shot[] = [
  desktopTeamPromptCards,
  librarySkills,
  libraryCreateSkillModal,
  libraryAdvancedSettings,
  libraryAddMcpModal,
  skillCreatedCard,
  denPluginDetail,
  denSkillEditor,
  denOfflineGptWeb,
  offlinegptWebTab,
];
