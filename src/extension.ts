import * as vscode from "vscode";
import * as fs from "fs/promises"; // Node.js promises API
import * as path from "path";
import * as childProcess from "child_process";
import { FileTreeDataProvider, FileTreeItem } from "./fileTreeDataProvider";

export function activate(context: vscode.ExtensionContext) {
  /**
   * 1) Load previously expanded folder IDs from globalState,
   *    or use an empty array if none saved yet.
   */
  const expandedIdsKey = "localFileViewer.expandedIds";
  const savedExpandedIds = context.globalState.get<string[]>(expandedIdsKey, []);
  let expandedIds = new Set<string>(savedExpandedIds);

  // 2) Read the folders from user/global settings
  const config = vscode.workspace.getConfiguration("localFileViewer", null);
  const folderPaths: string[] = config.get("folders") || [];

  // 3) Create and register your TreeDataProvider, passing in the expanded IDs
  //    (the constructor in fileTreeDataProvider.ts should accept a second parameter for initialExpandedIds)
  const fileDataProvider = new FileTreeDataProvider(folderPaths, expandedIds);

  const treeView = vscode.window.createTreeView("localFileViewerView", {
    treeDataProvider: fileDataProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  /**
   * 4) Listen for expand/collapse events so we can save the user’s expansion state.
   */
  treeView.onDidExpandElement((e) => {
    if (e.element.id) {
      expandedIds.add(e.element.id);
      // Save the new expandedIds array in globalState
      context.globalState.update(expandedIdsKey, Array.from(expandedIds));

      // Also update the data provider so it immediately knows about this
      fileDataProvider.setExpandedIds(expandedIds);
    }
  });

  treeView.onDidCollapseElement((e) => {
    if (e.element.id && expandedIds.has(e.element.id)) {
      expandedIds.delete(e.element.id);
      context.globalState.update(expandedIdsKey, Array.from(expandedIds));
      fileDataProvider.setExpandedIds(expandedIds);
    }
  });

  /**
   * 5) Watch for config changes (folders array) and update the data provider if changed.
   */
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("localFileViewer.folders")) {
      const newFolderPaths = vscode.workspace
        .getConfiguration("localFileViewer", null)
        .get<string[]>("folders") || [];
      fileDataProvider.folderPaths = newFolderPaths;
      fileDataProvider.refresh();
    }
  });

  // 6) Register the Add Folder command
  const addFolderCommand = vscode.commands.registerCommand(
    "localFileViewer.addFolder",
    async () => {
      // Show open dialog for selecting a folder
      const folderUri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Select Folder"
      });

      if (folderUri && folderUri.length > 0) {
        const selectedPath = folderUri[0].fsPath;

        // Get the current global folder array
        const configGlobal = vscode.workspace.getConfiguration(
          "localFileViewer",
          null
        );
        let folders = configGlobal.get<string[]>("folders") || [];

        // Add the new folder path, if not already present
        if (!folders.includes(selectedPath)) {
          folders.push(selectedPath);

          // Update global user settings (true => user settings)
          await configGlobal.update("folders", folders, true);

          // Refresh the provider so the folder shows up
          fileDataProvider.folderPaths = folders;
          fileDataProvider.refresh();
        } else {
          vscode.window.showInformationMessage("Folder already in list.");
        }
      }
    }
  );
  context.subscriptions.push(addFolderCommand);

  // 2) Register the toggle command
  const toggleShowHiddenCommand = vscode.commands.registerCommand(
    "localFileViewer.toggleShowHidden",
    () => {
      // Flip the boolean
      fileDataProvider.showHidden = !fileDataProvider.showHidden;

      // Optionally show a status message
      const newState = fileDataProvider.showHidden ? "Showing" : "Hiding";
      vscode.window.setStatusBarMessage(
        `${newState} hidden files`,
        3000 // disappear after 3s
      );

      // Refresh the tree to apply changes
      fileDataProvider.refresh();
    }
  );
  context.subscriptions.push(toggleShowHiddenCommand);

  // 7) Register the Remove Folder command
  const removeFolderCommand = vscode.commands.registerCommand(
    "localFileViewer.removeFolder",
    async (item: FileTreeItem) => {
      if (!item || !item.isRoot) {
        return;
      }

      // The path for the folder to remove
      const folderToRemove = item.filePath;

      // Get the current folder list
      const configGlobal = vscode.workspace.getConfiguration("localFileViewer", null);
      let folders = configGlobal.get<string[]>("folders") || [];

      // Filter out the removed folder
      folders = folders.filter((f) => f !== folderToRemove);

      // Update global settings
      await configGlobal.update("folders", folders, true);

      // Refresh the tree provider
      fileDataProvider.folderPaths = folders;
      fileDataProvider.refresh();

      vscode.window.showInformationMessage(`Removed folder: ${folderToRemove}`);
    }
  );
  context.subscriptions.push(removeFolderCommand);

  // 8) Register the "Reveal in Finder" command (macOS only)
  const revealInFinderCommand = vscode.commands.registerCommand(
    "localFileViewer.revealInFinder",
    (item: FileTreeItem) => {
      if (!item) {
        return;
      }
      // Only do something if on macOS
      if (process.platform === "darwin") {
        childProcess.exec(`open "${item.filePath}"`, (error) => {
          if (error) {
            vscode.window.showErrorMessage(
              `Failed to reveal in Finder: ${error.message}`
            );
          }
        });
      } else {
        vscode.window.showInformationMessage(
          "Reveal in Finder is only supported on macOS."
        );
      }
    }
  );
  context.subscriptions.push(revealInFinderCommand);

  // 9) Register the "Delete" command (files or folders)
  const deleteCommand = vscode.commands.registerCommand(
    "localFileViewer.deleteFileOrFolder",
    async (item: FileTreeItem) => {
      if (!item) {
        return;
      }
      const filePath = item.filePath;
      const isDir = item.isDirectory;

      // Prompt user for confirmation
      const answer = await vscode.window.showInformationMessage(
        `Are you sure you want to delete '${filePath}'? This action cannot be undone.`,
        { modal: true },
        "Yes",
        "No"
      );

      if (answer === "Yes") {
        try {
          // If it's a folder, remove recursively. If file, just unlink it.
          if (isDir) {
            await fs.rm(filePath, { recursive: true, force: true });
          } else {
            await fs.unlink(filePath);
          }

          vscode.window.showInformationMessage(`Deleted: ${filePath}`);

          // Refresh the tree view to reflect the change
          fileDataProvider.refresh();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Could not delete: ${err.message}`);
        }
      }
    }
  );
  context.subscriptions.push(deleteCommand);

  // 10) Register the "New File" command
  const createFileCommand = vscode.commands.registerCommand(
    "localFileViewer.createFile",
    async (item: FileTreeItem) => {
      if (!item || !item.isDirectory) {
        return;
      }

      // Prompt for the new filename
      const newFileName = await vscode.window.showInputBox({
        prompt: "Enter the new file name",
        validateInput: (value: string) => {
          if (!value || value.trim().length === 0) {
            return "Filename cannot be empty.";
          }
          return null;
        }
      });

      if (!newFileName) {
        // User canceled or provided invalid input
        return;
      }

      const newFilePath = path.join(item.filePath, newFileName);

      try {
        // Create an empty file
        await fs.writeFile(newFilePath, "");

        // Refresh the tree so the new file shows up
        fileDataProvider.refresh();

        // Open the file in the editor
        const doc = await vscode.workspace.openTextDocument(newFilePath);
        await vscode.window.showTextDocument(doc);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Could not create file: ${err.message}`);
      }
    }
  );
  context.subscriptions.push(createFileCommand);

  // 11) Register the "New Folder" command
  const createFolderCommand = vscode.commands.registerCommand(
    "localFileViewer.createFolder",
    async (item: FileTreeItem) => {
      if (!item || !item.isDirectory) {
        return;
      }

      // Prompt for the new folder name
      const newFolderName = await vscode.window.showInputBox({
        prompt: "Enter the new folder name",
        validateInput: (value: string) => {
          if (!value || value.trim().length === 0) {
            return "Folder name cannot be empty.";
          }
          return null;
        }
      });

      if (!newFolderName) {
        // User canceled
        return;
      }

      const newFolderPath = path.join(item.filePath, newFolderName);

      try {
        // Create the new folder
        await fs.mkdir(newFolderPath);

        // Refresh the tree so it shows up
        fileDataProvider.refresh();

        vscode.window.showInformationMessage(
          `Folder created: ${newFolderPath}`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Could not create folder: ${err.message}`);
      }
    }
  );
  context.subscriptions.push(createFolderCommand);

  // Register the "Rename" command
  const renameItemCommand = vscode.commands.registerCommand(
    "localFileViewer.renameFileOrFolder",
    async (item: FileTreeItem) => {
      if (!item) { return; }

      // Prompt for the new name
      const newName = await vscode.window.showInputBox({
        prompt: "Enter the new name",
        value: item.label, // pre-fill current name
        validateInput: (input) => {
          if (!input || input.trim().length === 0) {
            return "Name cannot be empty.";
          }
          return null;
        },
      });

      if (!newName) {
        // User canceled or provided invalid input
        return;
      }

      const oldPath = item.filePath;
      const parentDir = path.dirname(oldPath);
      const newPath = path.join(parentDir, newName);

      try {
        // Perform the rename
        await fs.rename(oldPath, newPath);

        // Show a success message
        vscode.window.showInformationMessage(`Renamed to: ${newPath}`);

        // Refresh the tree so the new name appears
        fileDataProvider.refresh();

        // Optionally, if it's a file, open the new file in the editor
        if (!item.isDirectory) {
          const doc = await vscode.workspace.openTextDocument(newPath);
          await vscode.window.showTextDocument(doc);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Could not rename: ${err.message}`);
      }
    }
  );

  context.subscriptions.push(renameItemCommand);


  // Register the "Open Default" command
  const openSystemDefaultCommand = vscode.commands.registerCommand(
    "localFileViewer.openSystemDefault",
    (item: FileTreeItem) => {
      if (!item) {
        return;
      }

      const filePath = item.filePath;

      // Cross-platform open in default app
      if (process.platform === "darwin") {
        // macOS
        childProcess.exec(`open "${filePath}"`, handleExecError);
      } else if (process.platform === "win32") {
        // Windows
        // Use "" for the title param to avoid issues with paths that have spaces
        childProcess.exec(`start "" "${filePath}"`, handleExecError);
      } else {
        // Linux / other
        childProcess.exec(`xdg-open "${filePath}"`, handleExecError);
      }
    }
  );

  context.subscriptions.push(openSystemDefaultCommand);
}

function handleExecError(error: any, stdout: string, stderr: string) {
  if (error) {
    vscode.window.showErrorMessage(`Failed to open file: ${error.message}`);
  }
}


export function deactivate() {}
