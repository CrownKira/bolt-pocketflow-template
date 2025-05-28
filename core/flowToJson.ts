import * as fs from 'fs';
import * as path from 'path';
import { BaseNode, Flow } from './pocketflow';

export interface VisualizationData {
    nodes: NodeData[];
    links: LinkData[];
    group_links: LinkData[];
    flows: Record<string, string>;
}

export interface NodeData {
    id: number;
    name: string;
    group: number;
    status: number;
    config: Record<string, unknown>;
    summary: string;
}

export interface LinkData {
    source: number;
    target: number;
    action: string;
}

export function flowToJson(start: BaseNode): VisualizationData {
    const nodes: NodeData[] = [];
    const links: LinkData[] = [];
    const groupLinks: LinkData[] = [];
    const nodeMap = new Map<BaseNode, number>();
    const flowGroups = new Map<Flow, number>();
    let nodeCounter = 1;
    let groupCounter = 1;

    function getNodeId(node: BaseNode): number {
        if (!nodeMap.has(node)) {
            nodeMap.set(node, nodeCounter++);
        }
        return nodeMap.get(node)!;
    }

    function getFlowGroupId(flow: Flow): number {
        if (!flowGroups.has(flow)) {
            flowGroups.set(flow, groupCounter++);
        }
        return flowGroups.get(flow)!;
    }

    function traverseNode(
        node: BaseNode,
        currentGroup: number = 0,
        visited = new Set<BaseNode>(),
    ): void {
        if (visited.has(node)) return;
        visited.add(node);

        if (node instanceof Flow) {
            // This is a Flow - create a group and process its contents
            const flowGroupId = getFlowGroupId(node);

            // Process the start node of this flow
            if (node.start) {
                traverseNode(node.start, flowGroupId, visited);
            }

            // Process flow's successors (connections to other flows)
            const successors = node.getSuccessors();
            for (const [action, successor] of successors.entries()) {
                if (successor instanceof Flow) {
                    // Flow to Flow connection - this becomes a group link
                    const targetGroupId = getFlowGroupId(successor);
                    groupLinks.push({
                        source: flowGroupId,
                        target: targetGroupId,
                        action: action,
                    });
                    traverseNode(successor, 0, visited);
                } else {
                    // Flow to Node connection
                    traverseNode(successor, flowGroupId, visited);
                }
            }
        } else {
            // This is a regular Node - add it to the nodes array
            const nodeId = getNodeId(node);

            if (!nodes.some((n) => n.id === nodeId)) {
                nodes.push({
                    id: nodeId,
                    name: node.constructor.name,
                    group: currentGroup,
                    status: node.getStatus(),
                    config: node.getConfig(),
                    summary: node.getSummary(),
                });
            }

            // Process node's successors
            const successors = node.getSuccessors();
            for (const [action, successor] of successors.entries()) {
                if (successor instanceof Flow) {
                    // Node to Flow connection
                    const targetGroupId = getFlowGroupId(successor);
                    groupLinks.push({
                        source: currentGroup,
                        target: targetGroupId,
                        action: action,
                    });
                    traverseNode(successor, 0, visited);
                } else {
                    // Node to Node connection
                    const successorId = getNodeId(successor);
                    links.push({
                        source: nodeId,
                        target: successorId,
                        action: action,
                    });
                    traverseNode(successor, currentGroup, visited);
                }
            }
        }
    }

    // Start traversal
    traverseNode(start);

    // Build flows mapping
    const flows: Record<string, string> = {};
    for (const [flow, groupId] of flowGroups.entries()) {
        flows[groupId.toString()] = flow.constructor.name;
    }

    return {
        nodes,
        links,
        group_links: groupLinks,
        flows,
    };
}

// Create viz directory if it doesn't exist
const vizDir = path.resolve(__dirname, '../viz');
if (!fs.existsSync(vizDir)) {
    fs.mkdirSync(vizDir, { recursive: true });
}

// Get all flow files
const flowsDir = path.resolve(__dirname, '../src/flows');
const flowFiles = fs
    .readdirSync(flowsDir)
    .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'));

// Process each flow file
async function processFlowFiles() {
    for (const flowFile of flowFiles) {
        try {
            // Import the flow module dynamically
            const flowModule = await import(path.join(flowsDir, flowFile));

            // Find the exported flow class instance
            let flowInstance: Flow | undefined;
            for (const exportKey of Object.keys(flowModule)) {
                if (flowModule[exportKey] instanceof Flow) {
                    flowInstance = flowModule[exportKey];
                    break;
                }
            }

            if (!flowInstance) {
                console.warn(`No Flow instance found in ${flowFile}`);
                continue;
            }

            // Convert flow to JSON
            const jsonData = flowToJson(flowInstance as BaseNode);

            // Create output filename
            const outputFilename = flowFile.replace('.js', '.json');
            const outputPath = path.join(vizDir, outputFilename);

            // Write JSON to file
            fs.writeFileSync(outputPath, JSON.stringify(jsonData, null, 2));
            console.log(`Converted ${flowFile} to ${outputPath}`);
        } catch (error) {
            console.error(`Error processing ${flowFile}:`, error);
        }
    }
}

processFlowFiles().catch((err) => {
    console.error('Error processing flow files:', err);
    process.exit(1);
});
