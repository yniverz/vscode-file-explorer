import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import chokidar from "chokidar";

/**
 * A TreeDataProvider that:
 * 1) Watches directories for file changes (using Chokidar).
 * 2) Updates automatically on file/folder add, remove, or change.
 * 3) Preserves expansion state by assigning stable IDs to items,
 *    and using an externally provided `expandedIds` set so that
 *    folders can remain expanded across refreshes / restarts.
 */
export class FileTreeDataProvider implements vscode.TreeDataProvider<FileTreeItem> {
  private _onDidChangeTreeData =
    new vscode.EventEmitter<FileTreeItem | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Track chokidar watchers, so we can dispose/recreate them if folderPaths change.
  private watchers: chokidar.FSWatcher[] = [];

  // The current list of root folder paths to display.
  private _folderPaths: string[] = [];

  /**
   * A set of IDs (file paths) for which the user wants the folder expanded.
   * This set is typically updated by onDidExpandElement / onDidCollapseElement
   * events in extension.ts, then passed into this data provider via setExpandedIds().
   */
  private expandedIds: Set<string> = new Set();

  /**
   * You can expose a getter/setter for folderPaths if you expect them to change at runtime.
   */
  public get folderPaths(): string[] {
    return this._folderPaths;
  }

  public set folderPaths(paths: string[]) {
    // Stop watching old paths
    this.disposeWatchers();

    this._folderPaths = paths;

    // Start watching new paths
    this.createWatchers(paths);

    // Refresh so new root folders appear immediately
    this.refresh();
  }

  /**
   * If the extension changes which folders should be expanded,
   * call setExpandedIds(...) so we update the tree item states.
   */
  public setExpandedIds(ids: Set<string>) {
    this.expandedIds = ids;
    // A refresh is needed so getTreeItem() can set the right collapsible states
    this.refresh();
  }

  /**
   * Optionally show hidden files/folders (dotfiles) in the tree.
   * This is a public property so the extension can toggle it.
   */
  public showHidden: boolean = false;

  /**
   * Constructs the data provider with a list of folder paths. 
   * Also optionally accepts an initial set of expanded IDs, if desired.
   */
  constructor(folderPaths: string[], initialExpandedIds?: Set<string>) {
    if (initialExpandedIds) {
      this.expandedIds = initialExpandedIds;
    }
    this.folderPaths = folderPaths; // invokes the setter, which creates watchers
  }

  /**
   * Creates chokidar watchers for each path, refreshing the tree 
   * whenever a file or folder is added, changed, or removed.
   */
  private createWatchers(paths: string[]) {
    for (const folderPath of paths) {
      const watcher = chokidar.watch(folderPath, {
        ignoreInitial: true,
        persistent: true,
        depth: 99
        // You can ignore hidden files, node_modules, etc. if desired:
        // ignored: /(^|[\/\\])\../
      });

      const refreshHandler = () => this.refresh();
      watcher
        .on("add", refreshHandler)
        .on("addDir", refreshHandler)
        .on("change", refreshHandler)
        .on("unlink", refreshHandler)
        .on("unlinkDir", refreshHandler);

      this.watchers.push(watcher);
    }
  }

  /**
   * Clean up watchers if folderPaths changes or on extension deactivate.
   */
  private disposeWatchers() {
    for (const w of this.watchers) {
      w.close().catch(() => {
        /* ignore errors */
      });
    }
    this.watchers = [];
  }

  /**
   * Called by VS Code to get the child items of the given element.
   * If `element` is undefined, that means we're at the top level (root).
   */
  public getChildren(element?: FileTreeItem): Thenable<FileTreeItem[]> {
    if (!element) {
      // Return top-level folders
      const roots = this._folderPaths.map(
        (folderPath) =>
          new FileTreeItem(folderPath, folderPath, true, true)
      );
      roots.sort((a, b) => a.label.localeCompare(b.label));
      return Promise.resolve(roots);
    }

    // For a folder item, list its contents
    const dirPath = element.resourceUri?.fsPath;
    if (!dirPath) {
      return Promise.resolve([]);
    }

    return new Promise((resolve) => {
      fs.readdir(dirPath, { withFileTypes: true }, (err, items) => {
        if (err) {
          return resolve([]);
        }
        let children = items.map((dirent) => {
          const itemPath = path.join(dirPath, dirent.name);
          return new FileTreeItem(
            dirent.name,
            itemPath,
            dirent.isDirectory(),
            false
          );
        });

        // Filter out dotfiles/folders if showHidden == false
        if (!this.showHidden) {
          children = children.filter((child) => {
            // If name starts with ".", skip
            return !child.label.startsWith(".");
          });
        }

        // Sort: folders first, then files
        children.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) { return -1; };
          if (!a.isDirectory && b.isDirectory) { return 1; };
          return a.label.localeCompare(b.label);
        });
        resolve(children);
      });
    });
  }

  /**
   * Return the visual representation (TreeItem) for each element.
   * We check whether this element's ID is in `expandedIds`,
   * to set the correct collapsible state so it remains expanded if desired.
   */
  public getTreeItem(element: FileTreeItem): vscode.TreeItem {
    if (element.isDirectory) {
      // If this folder ID is in expandedIds, expand it
      element.collapsibleState = this.expandedIds.has(element.id ?? "")
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    } else {
      element.collapsibleState = vscode.TreeItemCollapsibleState.None;
    }
    return element;
  }

  /**
   * Force the entire tree to refresh (or you can pass a specific element).
   */
  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Dispose watchers and any other resources.
   */
  public dispose(): void {
    this.disposeWatchers();
  }
}

/**
 * Represents a file or folder in the tree.
 * We assign a stable `id` using the file path, so VS Code can track
 * whether the user had expanded/collapsed this node in previous refreshes.
 */
export class FileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly filePath: string,
    public readonly isDirectory: boolean,
    public readonly isRoot: boolean
  ) {
    // The collapsible state is typically overridden in getTreeItem() 
    // based on whether it's in expandedIds, but we must pass a default here.
    super(
      label,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    // Use the file path as a stable, unique ID
    this.id = filePath;

    // This lets VS Code provide default icons for folders/files
    this.resourceUri = vscode.Uri.file(filePath);

    // Files open on click; folders do not by default
    if (!isDirectory) {
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [this.resourceUri],
      };
    }

    // Context values let you show different context menu items 
    // for root folders vs. subfolders vs. files, if you wish.
    if (isDirectory && isRoot) {
      this.contextValue = "rootFolder";
    } else if (isDirectory) {
      this.contextValue = "folder";
    } else {
      this.contextValue = "file";
    }
  }
}
