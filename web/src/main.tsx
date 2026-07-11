import { render } from "preact";
import { App } from "./App";
import { installClientErrorReporter } from "./srs";
import { STRINGS } from "./strings";
import "./tokens.css";
import "./app.css";

installClientErrorReporter();

const root = document.getElementById("app");
if (!root) throw new Error(STRINGS.appRootMissing);
render(<App />, root);
