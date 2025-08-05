#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ReadResourceRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { readdir, stat, readFile, watch } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";
import { existsSync } from "node:fs";

interface CodebaseConfig {
	rootPath: string;
	includePatterns: string[];
	excludePatterns: string[];
	maxFileSize: number;
	maxDepth: number;
}

interface FileInfo {
	path: string;
	relativePath: string;
	type: string;
	size: number;
	category: "source" | "config" | "test" | "doc" | "build" | "other";
}

interface PackageJson {
	name?: string;
	version?: string;
	description?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface ProjectStructure {
	rootPath: string;
	packageJson: PackageJson;
	framework: string;
	totalFiles: number;
	categories: Record<string, number>;
	extensions: Record<string, number>;
	directories: Record<string, string[]>;
}

interface IngestCodebaseArgs {
	path: string;
	includeTests?: boolean;
	includeDocs?: boolean;
	maxDepth?: number;
}

interface SearchFilesArgs {
	pattern?: string;
	content?: string;
	fileType?: string;
	category?: string;
}

class ViteMCPServer {
	private server: Server;
	private codebaseConfig: CodebaseConfig | null = null;
	private fileIndex: Map<string, FileInfo> = new Map();
	private projectStructure: ProjectStructure | null = null;
	private fileWatcher: AbortController | null = null;

	constructor() {
		this.server = new Server(
			{
				name: "vite-codebase-mcp",
				version: "1.0.0",
				description: "MCP server for analyzing Vite application codebases",
			},
			{
				capabilities: {
					resources: {},
					tools: {},
				},
			},
		);

		this.setupHandlers();
	}

	private setupHandlers() {
		// List available tools
		this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [
				{
					name: "ingest_codebase",
					description: "Ingest and analyze a Vite codebase from a given path",
					inputSchema: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "Root path of the Vite project to analyze",
							},
							includeTests: {
								type: "boolean",
								description: "Whether to include test files (default: true)",
								default: true,
							},
							includeDocs: {
								type: "boolean",
								description:
									"Whether to include documentation files (default: true)",
								default: true,
							},
							maxDepth: {
								type: "number",
								description: "Maximum directory depth to scan (default: 10)",
								default: 10,
							},
						},
						required: ["path"],
					},
				},
				{
					name: "get_project_structure",
					description:
						"Get the overall structure and summary of the ingested codebase",
					inputSchema: {
						type: "object",
						properties: {},
					},
				},
				{
					name: "search_files",
					description:
						"Search for files matching a pattern or containing specific content",
					inputSchema: {
						type: "object",
						properties: {
							pattern: {
								type: "string",
								description:
									"File name pattern to search for (supports wildcards)",
							},
							content: {
								type: "string",
								description: "Text content to search for within files",
							},
							fileType: {
								type: "string",
								description:
									"Filter by file extension (e.g., 'ts', 'vue', 'jsx')",
							},
							category: {
								type: "string",
								enum: ["source", "config", "test", "doc", "build", "other"],
								description: "Filter by file category",
							},
						},
					},
				},
			],
		}));

		// List available resources
		this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
			if (!this.codebaseConfig) {
				return { resources: [] };
			}

			const resources = Array.from(this.fileIndex.values()).map((file) => ({
				uri: `file://${file.relativePath}`,
				name: file.relativePath,
				description: `${file.category} file (${file.type})`,
				mimeType: this.getMimeType(file.type),
			}));

			// Add special resources
			resources.unshift(
				{
					uri: "project://structure",
					name: "Project Structure",
					description: "Complete project structure and analysis",
					mimeType: "application/json",
				},
				{
					uri: "project://summary",
					name: "Project Summary",
					description: "High-level project summary and tech stack",
					mimeType: "text/plain",
				},
			);

			return { resources };
		});

		// Get resource content
		this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			const { uri } = request.params;

			if (uri === "project://structure") {
				return {
					contents: [
						{
							uri,
							mimeType: "application/json",
							text: JSON.stringify(this.projectStructure, null, 2),
						},
					],
				};
			}

			if (uri === "project://summary") {
				return {
					contents: [
						{
							uri,
							mimeType: "text/plain",
							text: this.generateProjectSummary(),
						},
					],
				};
			}

			if (uri.startsWith("file://")) {
				const relativePath = uri.replace("file://", "");
				const file = Array.from(this.fileIndex.values()).find(
					(f) => f.relativePath === relativePath,
				);

				if (!file) {
					throw new McpError(
						ErrorCode.InvalidRequest,
						`File not found: ${relativePath}`,
					);
				}

				try {
					const content = await readFile(file.path, "utf-8");
					return {
						contents: [
							{
								uri,
								mimeType: this.getMimeType(file.type),
								text: content,
							},
						],
					};
				} catch (error) {
					throw new McpError(
						ErrorCode.InternalError,
						`Failed to read file: ${error}`,
					);
				}
			}

			throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
		});

		// Handle tool calls
		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const { name, arguments: args } = request.params;

			switch (name) {
				case "ingest_codebase":
					return await this.ingestCodebase(args as unknown as IngestCodebaseArgs);
				case "get_project_structure":
					return await this.getProjectStructure();
				case "search_files":
					return await this.searchFiles(args as unknown as SearchFilesArgs);
				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		});
	}

	private async ingestCodebase(args: {
		path: string;
		includeTests?: boolean;
		includeDocs?: boolean;
		maxDepth?: number;
	}) {
		const {
			path,
			includeTests = true,
			includeDocs = true,
			maxDepth = 10,
		} = args;

		if (!existsSync(path)) {
			throw new McpError(
				ErrorCode.InvalidRequest,
				`Path does not exist: ${path}`,
			);
		}

		// Check if it's a Vite project
		const packageJsonPath = join(path, "package.json");
		if (!existsSync(packageJsonPath)) {
			throw new McpError(
				ErrorCode.InvalidRequest,
				"No package.json found. Is this a Node.js project?",
			);
		}

		this.codebaseConfig = {
			rootPath: path,
			includePatterns: this.buildIncludePatterns(includeTests, includeDocs),
			excludePatterns: this.buildExcludePatterns(),
			maxFileSize: 1024 * 1024, // 1MB
			maxDepth,
		};

		this.fileIndex.clear();

		try {
			await this.scanDirectory(path, 0);
			await this.analyzeProject();
			
			// Start file watcher in background
			this.startFileWatcher().catch(error => {
				console.error("Failed to start file watcher:", error);
			});

			const stats = this.getIngestionStats();

			return {
				content: [
					{
						type: "text",
						text: `Successfully ingested Vite codebase from: ${path}\n\n${stats}`,
					},
				],
			};
		} catch (error) {
			throw new McpError(
				ErrorCode.InternalError,
				`Failed to ingest codebase: ${error}`,
			);
		}
	}

	private async scanDirectory(dirPath: string, depth: number) {
		if (!this.codebaseConfig || depth > this.codebaseConfig.maxDepth) return;

		const entries = await readdir(dirPath);

		for (const entry of entries) {
			const fullPath = join(dirPath, entry);
			const relativePath = relative(this.codebaseConfig.rootPath, fullPath);

			// Skip excluded patterns
			if (this.shouldExclude(relativePath)) continue;

			const stats = await stat(fullPath);

			if (stats.isDirectory()) {
				await this.scanDirectory(fullPath, depth + 1);
			} else if (stats.isFile()) {
				// Skip large files
				if (stats.size > this.codebaseConfig.maxFileSize) continue;

				const ext = extname(entry).slice(1);
				const category = this.categorizeFile(relativePath, ext);

				this.fileIndex.set(relativePath, {
					path: fullPath,
					relativePath,
					type: ext || "unknown",
					size: stats.size,
					category,
				});
			}
		}
	}

	private shouldExclude(relativePath: string): boolean {
		if (!this.codebaseConfig) return false;
		const excludePatterns = this.codebaseConfig.excludePatterns;
		return excludePatterns.some((pattern) => {
			if (pattern.includes("*")) {
				const regex = new RegExp(pattern.replace(/\*/g, ".*"));
				return regex.test(relativePath);
			}
			return relativePath.includes(pattern);
		});
	}

	private categorizeFile(
		relativePath: string,
		ext: string,
	): FileInfo["category"] {
		const path = relativePath.toLowerCase();

		// Test files
		if (
			path.includes("test") ||
			path.includes("spec") ||
			path.includes("__tests__")
		) {
			return "test";
		}

		// Config files
		if (
			path.includes("config") ||
			["json", "yaml", "yml", "toml", "env"].includes(ext) ||
			basename(relativePath).startsWith(".")
		) {
			return "config";
		}

		// Documentation
		if (["md", "txt", "rst"].includes(ext) || path.includes("doc")) {
			return "doc";
		}

		// Build/dist files
		if (
			path.includes("dist") ||
			path.includes("build") ||
			path.includes(".output")
		) {
			return "build";
		}

		// Source files
		if (
			[
				"js",
				"ts",
				"jsx",
				"tsx",
				"vue",
				"svelte",
				"css",
				"scss",
				"sass",
				"less",
			].includes(ext)
		) {
			return "source";
		}

		return "other";
	}

	private async analyzeProject() {
		const packageJsonFile = Array.from(this.fileIndex.values()).find(
			(f) => f.relativePath === "package.json",
		);

		let packageJson = {};
		if (packageJsonFile) {
			try {
				const content = await readFile(packageJsonFile.path, "utf-8");
				packageJson = JSON.parse(content);
			} catch (error) {
				console.error("Failed to parse package.json:", error);
			}
		}

		// Analyze project structure
		const categories = Array.from(this.fileIndex.values()).reduce(
			(acc, file) => {
				acc[file.category] = (acc[file.category] || 0) + 1;
				return acc;
			},
			{} as Record<string, number>,
		);

		const extensions = Array.from(this.fileIndex.values()).reduce(
			(acc, file) => {
				acc[file.type] = (acc[file.type] || 0) + 1;
				return acc;
			},
			{} as Record<string, number>,
		);

		// Detect framework
		const framework = this.detectFramework(packageJson, extensions);

		this.projectStructure = {
			rootPath: this.codebaseConfig?.rootPath ?? "",
			packageJson,
			framework,
			totalFiles: this.fileIndex.size,
			categories,
			extensions,
			directories: this.getDirectoryStructure(),
		};
	}

	private detectFramework(
		packageJson: PackageJson,
		extensions: Record<string, number>,
	): string {
		const deps = {
			...packageJson.dependencies,
			...packageJson.devDependencies,
		};

		if (deps?.vue || (extensions.vue ?? 0) > 0) return "Vue";
		if (deps?.react || (extensions.jsx ?? 0) > 0 || (extensions.tsx ?? 0) > 0) return "React";
		if (deps?.svelte || (extensions.svelte ?? 0) > 0) return "Svelte";
		if (deps?.["@angular/core"]) return "Angular";

		return "Vanilla";
	}

	private getDirectoryStructure(): Record<string, string[]> {
		const structure: Record<string, string[]> = {};

		for (const file of this.fileIndex.values()) {
			const parts = file.relativePath.split("/");
			if (parts.length > 1) {
				const dir = parts.slice(0, -1).join("/");
				if (!structure[dir]) structure[dir] = [];
				const fileName = parts[parts.length - 1];
				if (fileName) {
					structure[dir].push(fileName);
				}
			} else {
				if (!structure.root) structure.root = [];
				structure.root.push(file.relativePath);
			}
		}

		return structure;
	}

	private async getProjectStructure() {
		if (!this.projectStructure) {
			throw new McpError(
				ErrorCode.InvalidRequest,
				"No codebase has been ingested yet",
			);
		}

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(this.projectStructure, null, 2),
				},
			],
		};
	}

	private async searchFiles(args: {
		pattern?: string;
		content?: string;
		fileType?: string;
		category?: string;
	}) {
		if (!this.codebaseConfig) {
			throw new McpError(
				ErrorCode.InvalidRequest,
				"No codebase has been ingested yet",
			);
		}

		let results = Array.from(this.fileIndex.values());

		// Filter by category
		if (args.category) {
			results = results.filter((file) => file.category === args.category);
		}

		// Filter by file type
		if (args.fileType) {
			results = results.filter((file) => file.type === args.fileType);
		}

		// Filter by file name pattern
		if (args.pattern) {
			const regex = new RegExp(args.pattern.replace(/\*/g, ".*"), "i");
			results = results.filter((file) => regex.test(file.relativePath));
		}

		// Search content
		if (args.content) {
			const contentResults: FileInfo[] = [];
			for (const file of results) {
				try {
					const content = await readFile(file.path, "utf-8");
					if (content.toLowerCase().includes(args.content.toLowerCase())) {
						contentResults.push(file);
					}
				} catch (error) {
					// Skip files that can't be read
				}
			}
			results = contentResults;
		}

		const summary = `Found ${results.length} matching files:\n\n${results
			.map(
				(file) => `- ${file.relativePath} (${file.category}, ${file.type})`,
			)
			.join("\n")}`;

		return {
			content: [
				{
					type: "text",
					text: summary,
				},
			],
		};
	}

	private buildIncludePatterns(
		includeTests: boolean,
		includeDocs: boolean,
	): string[] {
		const patterns = [
			"src/**",
			"public/**",
			"package.json",
			"vite.config.*",
			"tsconfig.json",
		];

		if (includeTests) {
			patterns.push("**/*.test.*", "**/*.spec.*", "tests/**", "__tests__/**");
		}

		if (includeDocs) {
			patterns.push("README.*", "*.md", "docs/**");
		}

		return patterns;
	}

	private buildExcludePatterns(): string[] {
		return [
			"node_modules",
			"dist",
			"build",
			".git",
			".vscode",
			".idea",
			"coverage",
			".nyc_output",
			".env",
			".env.local",
			".env.production",
			"*.log",
			".DS_Store",
			"Thumbs.db",
		];
	}

	private getIngestionStats(): string {
		const categories = Array.from(this.fileIndex.values()).reduce(
			(acc, file) => {
				acc[file.category] = (acc[file.category] || 0) + 1;
				return acc;
			},
			{} as Record<string, number>,
		);

		const totalSize = Array.from(this.fileIndex.values()).reduce(
			(acc, file) => acc + file.size,
			0,
		);

		return `Statistics:
- Total files: ${this.fileIndex.size}
- Total size: ${(totalSize / 1024).toFixed(1)} KB
- Source files: ${categories.source || 0}
- Config files: ${categories.config || 0}
- Test files: ${categories.test || 0}
- Documentation: ${categories.doc || 0}
- Framework: ${this.projectStructure?.framework || "Unknown"}`;
	}

	private generateProjectSummary(): string {
		if (!this.projectStructure) return "No project analyzed yet";

		const { packageJson, framework, totalFiles, categories } =
			this.projectStructure;

		return `# Project Summary

**Framework:** ${framework}
**Total Files:** ${totalFiles}

## Package Information
- Name: ${packageJson.name || "Unknown"}
- Version: ${packageJson.version || "Unknown"}
- Description: ${packageJson.description || "No description"}

## File Distribution
${Object.entries(categories)
	.map(([cat, count]) => `- ${cat}: ${count} files`)
	.join("\n")}

## Key Dependencies
${this.getKeyDependencies(packageJson).join("\n")}

## Project Structure
This appears to be a ${framework} application built with Vite, containing ${categories.source || 0} source files and ${categories.config || 0} configuration files.
`;
	}

	private getKeyDependencies(packageJson: PackageJson): string[] {
		const deps = {
			...packageJson.dependencies,
			...packageJson.devDependencies,
		};
		const important = [
			"react",
			"vue",
			"svelte",
			"typescript",
			"vite",
			"@vitejs/plugin-react",
			"@vitejs/plugin-vue",
		];

		return important
			.filter((dep) => deps[dep])
			.map((dep) => `- ${dep}: ${deps[dep]}`);
	}

	private async startFileWatcher() {
		if (!this.codebaseConfig) return;
		
		// Stop existing watcher if running
		if (this.fileWatcher) {
			this.fileWatcher.abort();
		}

		this.fileWatcher = new AbortController();
		
		try {
			const watcher = watch(this.codebaseConfig.rootPath, {
				recursive: true,
				signal: this.fileWatcher.signal,
			});

			for await (const event of watcher) {
				if (event.filename) {
					await this.handleFileChange(event.eventType, event.filename);
				}
			}
		} catch (error) {
			if (error instanceof Error && error.name !== "AbortError") {
				console.error("File watcher error:", error);
			}
		}
	}

	private async handleFileChange(eventType: string, filename: string) {
		if (!this.codebaseConfig) return;

		const fullPath = join(this.codebaseConfig.rootPath, filename);
		const relativePath = relative(this.codebaseConfig.rootPath, fullPath);

		// Skip excluded files
		if (this.shouldExclude(relativePath)) return;

		try {
			if (eventType === "rename") {
				// File was created or deleted
				if (existsSync(fullPath)) {
					await this.addOrUpdateFile(fullPath, relativePath);
				} else {
					this.removeFile(relativePath);
				}
			} else if (eventType === "change") {
				// File was modified
				if (existsSync(fullPath)) {
					await this.addOrUpdateFile(fullPath, relativePath);
				}
			}

			// Re-analyze project structure after changes
			await this.analyzeProject();
		} catch (error) {
			console.error(`Error handling file change for ${filename}:`, error);
		}
	}

	private async addOrUpdateFile(fullPath: string, relativePath: string) {
		if (!this.codebaseConfig) return;

		try {
			const stats = await stat(fullPath);
			
			if (stats.isFile() && stats.size <= this.codebaseConfig.maxFileSize) {
				const ext = extname(relativePath).slice(1);
				const category = this.categorizeFile(relativePath, ext);

				this.fileIndex.set(relativePath, {
					path: fullPath,
					relativePath,
					type: ext || "unknown",
					size: stats.size,
					category,
				});
			}
		} catch (error) {
			// File might have been deleted between check and stat
		}
	}

	private removeFile(relativePath: string) {
		this.fileIndex.delete(relativePath);
	}

	private stopFileWatcher() {
		if (this.fileWatcher) {
			this.fileWatcher.abort();
			this.fileWatcher = null;
		}
	}

	private getMimeType(extension: string): string {
		const mimeTypes: Record<string, string> = {
			js: "application/javascript",
			ts: "application/typescript",
			jsx: "application/javascript",
			tsx: "application/typescript",
			vue: "text/x-vue",
			svelte: "text/x-svelte",
			css: "text/css",
			scss: "text/x-scss",
			sass: "text/x-sass",
			less: "text/x-less",
			html: "text/html",
			json: "application/json",
			md: "text/markdown",
			txt: "text/plain",
			yaml: "text/yaml",
			yml: "text/yaml",
		};

		return mimeTypes[extension] || "text/plain";
	}

	async run() {
		const transport = new StdioServerTransport();
		await this.server.connect(transport);
		console.error("Vite MCP Server running on stdio");

		// Handle graceful shutdown
		process.on("SIGINT", () => {
			this.stopFileWatcher();
			process.exit(0);
		});

		process.on("SIGTERM", () => {
			this.stopFileWatcher();
			process.exit(0);
		});
	}
}

// Start the server
const server = new ViteMCPServer();
await server.run();
