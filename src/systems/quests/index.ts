import questDefinitions from "./definitions";
import questLog from "./log";
import questObjectives from "./objectives";
import questRewards from "./rewards";
import questMarkers from "./markers";
import questEditor from "./editor";
import { registerExploreHooks } from "./objectives";
import { registerLevelUpHook } from "./markers";

registerExploreHooks();
registerLevelUpHook();

export { questDefinitions, questLog, questObjectives, questRewards, questMarkers, questEditor };
export default {
  definitions: questDefinitions,
  log: questLog,
  objectives: questObjectives,
  rewards: questRewards,
  markers: questMarkers,
  editor: questEditor,
};
