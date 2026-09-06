import { parentPort, workerData } from "node:worker_threads";
import { buildCommunityGraph, type CommunityGraphInput } from "./community-graph.js";

parentPort!.postMessage(buildCommunityGraph(workerData as CommunityGraphInput));
