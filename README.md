# Vite Codebase MCP Server

A Model Context Protocol (MCP) server that analyzes Vite application codebases, providing AI assistants like Claude with deep insights into your project structure, code patterns, and architecture.

## Features

- **Smart Codebase Ingestion**: Automatically scans and categorizes files in any Vite project
- **Framework Detection**: Identifies whether you're using React, Vue, Svelte, or vanilla JS
- **Intelligent Filtering**: Excludes node_modules, build files, and other non-essential content
- **File Categorization**: Organizes files into source, config, test, documentation, and build categories
- **Content Search**: Search files by name patterns, content, type, or category
- **Project Analysis**: Provides detailed project structure and dependency information

## Installation

### Prerequisites
- [Bun](https://bun.sh/) installed on your system
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) for local MCP usage

### Setup

1. **Clone or create the project:**
```bash
mkdir vite-mcp-server
cd vite-mcp-server
```

2. **Save the server code** as `server.ts` and package.json as shown in the artifacts above

3. **Install dependencies:**
```bash
bun install
```

4. **Make the server executable:**
```bash
chmod +x server.ts
```

## Usage

### With Claude Code

1. **Configure Claude Code** to use this MCP server by adding to your Claude Code config:

```json
{
  "mcps": {
    "vite-codebase": {
      "command": "bun",
      "args": ["run", "/path/to/vite-mcp-server/server.ts"],
      "env": {}
    }
  }
}
```

2. **Start Claude Code** and the MCP server will be available

3. **Ingest a codebase:**
```
Hey Claude, can you ingest the Vite codebase at /path/to/my-vite-project?
```

### Available Tools

#### `ingest_codebase`
Analyzes a Vite project from a given path.

```json
{
  "path": "/path/to/vite/project",
  "includeTests": true,
  "includeDocs": true, 
  "maxDepth": 10
}
```

#### `get_project_structure`
Returns the complete project analysis including:
- Framework detection
- File distribution by category
- Directory structure
- Package.json analysis
- Key dependencies

#### `search_files`
Search for files by various criteria:

```json
{
  "pattern": "*.vue",
  "content": "useState",
  "fileType": "ts",
  "category": "source"
}
```

### Available Resources

Once a codebase is ingested, you can access:

- `project://structure` - Complete project structure as JSON
- `project://summary` - Human-readable project summary
- `file://path/to/file` - Individual file contents

## Example Workflow

```bash
# Start the server
bun run server.ts

# In Claude Code:
# "Ingest the codebase at /Users/me/my-vite-app"
# "Show me the project structure"
# "Find all Vue components that use the Composition API"
# "What's the overall architecture of this application?"
# "Generate a new component following this project's patterns"
```

## Supported File Types

### Source Files
- JavaScript/TypeScript (`.js`, `.ts`, `.jsx`, `.tsx`)
- Vue components (`.vue`)
- Svelte components (`.svelte`)
- Stylesheets (`.css`, `.scss`, `.sass`, `.less`)

### Configuration Files
- `package.json`, `vite.config.*`, `tsconfig.json`
- Environment files (`.env*`)
- Other config formats (`.yaml`, `.toml`, etc.)

### Documentation
- Markdown files (`.md`)
- README files
- Documentation directories

## Configuration

The server intelligently excludes common directories and files:

### Excluded by Default
- `node_modules/`
- `dist/`, `build/`
- `.git/`, `.vscode/`, `.idea/`
- `coverage/`, `.nyc_output/`
- Log files and OS files

### File Size Limits
- Maximum file size: 1MB
- Maximum directory depth: 10 levels (configurable)

## Security

- **Local only**: Runs entirely on your local machine
- **No internet required**: All processing happens locally
- **Selective access**: Only reads files you explicitly point it to
- **Respects .gitignore patterns**: Won't expose sensitive files

## Troubleshooting

### Common Issues

1. **"Path does not exist"**: Ensure the provided path is correct and accessible
2. **"No package.json found"**: Make sure you're pointing to a Node.js/Vite project root
3. **Permission errors**: Ensure the server has read access to the target directory

### Debug Mode
Run with additional logging:
```bash
DEBUG=1 bun run server.ts
```

## Contributing

This is a generic Vite MCP server that can be extended for specific needs:

- Add support for other build tools (Webpack, Rollup, etc.)
- Implement more sophisticated code analysis
- Add support for monorepos
- Include dependency graph analysis

## License

MIT License - feel free to modify and distribute as needed.

## Next Steps

After setting up:

1. Configure Claude Code to use this MCP server
2. Point it at one of your Vite projects
3. Start asking Claude about your codebase structure
4. Use Claude to generate code that follows your existing patterns

The server provides deep context about your codebase, enabling much more accurate and relevant assistance from Claude.