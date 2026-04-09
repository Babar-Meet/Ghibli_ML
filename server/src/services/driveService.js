import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { google } from "googleapis";
import { config } from "../config.js";

const localStorageRoot = path.resolve(process.cwd(), "local-storage");
const folderByKind = {
  original: "original",
  generated: "generated",
};

let drivePromise = null;
let driveDisabledReason = "";
let driveWarningShown = false;

function warnDriveFallback(reason) {
  if (driveWarningShown) {
    return;
  }

  console.warn(`[drive] ${reason}. Falling back to local storage.`);
  driveWarningShown = true;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildDriveClient() {
  if (!config.googleDrive.credentialsPath) {
    driveDisabledReason = "GOOGLE_APPLICATION_CREDENTIALS is not configured";
    console.warn(`[drive] ${driveDisabledReason}. Falling back to local storage.`);
    driveWarningShown = true;
    return null;
  }

  const resolvedCredentialsPath = path.resolve(
    process.cwd(),
    config.googleDrive.credentialsPath,
  );

  console.log(`[drive] Looking for credentials at: ${resolvedCredentialsPath}`);

  if (!(await fileExists(resolvedCredentialsPath))) {
    driveDisabledReason = `Credentials file not found at ${resolvedCredentialsPath}`;
    console.warn(`[drive] ${driveDisabledReason}. Falling back to local storage.`);
    driveWarningShown = true;
    return null;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: resolvedCredentialsPath,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });

    const authClient = await auth.getClient();
    console.log("[drive] Google Auth client created successfully");

    const drive = google.drive({ version: "v3", auth: authClient });

    const about = await drive.about.get({ fields: "user" });
    console.log(`[drive] Connected as: ${about.data.user?.emailAddress}`);

    const folderId = config.googleDrive.originalFolderId;
    if (folderId) {
      try {
        const folder = await drive.files.get({ fileId: folderId, fields: "id,name" });
        console.log(`[drive] Original folder accessible: ${folder.data.name} (${folderId})`);
      } catch (e) {
        console.warn(`[drive] Cannot access original folder ${folderId}: ${e.message}`);
      }
    }

    driveDisabledReason = "";
    return drive;
  } catch (error) {
    driveDisabledReason = `Failed to initialize Google Drive client: ${error.message}`;
    console.error(`[drive] ${driveDisabledReason}. Falling back to local storage.`);
    driveWarningShown = true;
    return null;
  }
}

async function getDriveClient() {
  if (!drivePromise) {
    drivePromise = buildDriveClient();
  }

  return drivePromise;
}

function folderIdByKind(kind) {
  return kind === "generated"
    ? config.googleDrive.generatedFolderId
    : config.googleDrive.originalFolderId;
}

function extensionFromMimeType(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

async function uploadToDrive({ drive, buffer, mimeType, fileName, kind }) {
  const folderId = folderIdByKind(kind);
  const ext = extensionFromMimeType(mimeType);
  const driveFileName = fileName.endsWith(`.${ext}`)
    ? fileName
    : `${fileName}.${ext}`;

  console.log(`[drive] Uploading ${kind} file: ${driveFileName} to folder: ${folderId}`);

  try {
    const created = await drive.files.create({
      requestBody: {
        name: driveFileName,
        parents: folderId ? [folderId] : undefined,
      },
      media: {
        mimeType,
        body: Readable.from(buffer),
      },
      fields: "id,name",
    });

    console.log(`[drive] File created with ID: ${created.data.id}`);

    const fileId = created.data.id;

    if (!fileId) {
      throw new Error("Google Drive did not return a file id.");
    }

    if (config.googleDrive.makePublic) {
      console.log(`[drive] Making file public: ${fileId}`);
      await drive.permissions.create({
        fileId,
        requestBody: {
          role: "reader",
          type: "anyone",
        },
      });
      console.log(`[drive] File is now public`);
    }

    const details = await drive.files.get({
      fileId,
      fields: "id,name,webViewLink,webContentLink,thumbnailLink",
    });

    console.log(`[drive] Got file details. View URL: ${details.data.webViewLink}`);

    return {
      storage: "drive",
      id: details.data.id,
      fileName: details.data.name,
      viewUrl:
        details.data.webViewLink ??
        `https://drive.google.com/file/d/${fileId}/view`,
      downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
      previewUrl:
        details.data.thumbnailLink ??
        `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`,
    };
  } catch (error) {
    console.error(`[drive] Upload failed: ${error.message}`);
    throw error;
  }
}

async function uploadToLocal({ buffer, mimeType, fileName, kind }) {
  const ext = extensionFromMimeType(mimeType);
  const normalizedName = fileName.endsWith(`.${ext}`)
    ? fileName
    : `${fileName}.${ext}`;
  const folderName = folderByKind[kind] ?? folderByKind.original;
  const targetDir = path.join(localStorageRoot, folderName);
  const targetPath = path.join(targetDir, normalizedName);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetPath, buffer);

  const relativePath = `/files/${folderName}/${normalizedName}`;
  const absoluteUrl = `${config.publicBaseUrl}${relativePath}`;

  return {
    storage: "local",
    id: normalizedName,
    fileName: normalizedName,
    viewUrl: absoluteUrl,
    downloadUrl: absoluteUrl,
    previewUrl: absoluteUrl,
  };
}

export async function ensureLocalStorageReady() {
  await fs.mkdir(path.join(localStorageRoot, folderByKind.original), {
    recursive: true,
  });
  await fs.mkdir(path.join(localStorageRoot, folderByKind.generated), {
    recursive: true,
  });
}

export function getLocalStorageRoot() {
  return localStorageRoot;
}

export function getDriveStatus() {
  return {
    configured: Boolean(
      config.googleDrive.credentialsPath &&
        config.googleDrive.originalFolderId &&
        config.googleDrive.generatedFolderId,
    ),
    credentialsPath: config.googleDrive.credentialsPath || null,
    originalFolderConfigured: Boolean(config.googleDrive.originalFolderId),
    generatedFolderConfigured: Boolean(config.googleDrive.generatedFolderId),
    disabledReason: driveDisabledReason || null,
    fallbackWarningShown: driveWarningShown,
  };
}

export async function uploadImage({ buffer, mimeType, fileName, kind }) {
  const drive = await getDriveClient();
  const folderId = folderIdByKind(kind);

  console.log(`[drive] uploadImage called: kind=${kind}, folderId=${folderId}, drive=${drive ? 'available' : 'not available'}`);

  if (drive && folderId) {
    try {
      console.log(`[drive] Attempting to upload to Google Drive...`);
      return await uploadToDrive({ drive, buffer, mimeType, fileName, kind });
    } catch (error) {
      console.error(`[drive] Drive upload failed: ${error.message}`);
      driveDisabledReason = `Drive upload failed: ${error.message}`;
      driveWarningShown = false;
      drivePromise = Promise.resolve(null);
    }
  } else {
    console.log(`[drive] Skipping Drive upload. drive=${!!drive}, folderId=${folderId}`);
  }

  console.log(`[drive] Falling back to local storage`);
  return uploadToLocal({ buffer, mimeType, fileName, kind });
}
