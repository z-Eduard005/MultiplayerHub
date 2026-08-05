import UI from "@z-eduard005/tui-lib";
import { APP_NAME, APP_VERSION } from "../constants";

const ui = new UI(`${APP_NAME} v${APP_VERSION}`, "blue");
export type { ListItem, LogType } from "@z-eduard005/tui-lib";
export default ui;
