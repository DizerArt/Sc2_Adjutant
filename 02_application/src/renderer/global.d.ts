import type { Sc2AssistantBridge } from "../shared/ipc/contracts.js";

declare global {
  interface Window {
    readonly sc2Assistant?: Sc2AssistantBridge;
  }
}

declare module "*.png" {
  const url: string;
  export default url;
}

declare module "*.gif" {
  const url: string;
  export default url;
}

export {};

