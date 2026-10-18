/// <reference lib="dom" />
import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const root = document.getElementById("svelte-root");
if (root !== null) {
  mount(App, { target: root });
}
