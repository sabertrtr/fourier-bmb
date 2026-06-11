const axios = require("axios");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DanbooruClient {
  constructor(config) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.username = config.username;
    this.apiKey = config.api_key;
  }

  _client() {
    return axios.create({
      baseURL: this.baseUrl,
      params: {
        login: this.username,
        api_key: this.apiKey,
      },
      timeout: 30000,
    });
  }

  async createUpload(sourceUrl) {
    const resp = await this._client().post("/uploads.json", {
      upload: { source: sourceUrl },
    });
    return resp.data;
  }

  async createUploadFromBytes(buffer, filename, contentType) {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("upload[files][0]", buffer, {
      filename: filename,
      contentType: contentType,
    });
    const resp = await this._client().post("/uploads.json", form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return resp.data;
  }

  async waitForUpload(uploadId, { intervalMs = 2000, timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resp = await this._client().get(`/uploads/${uploadId}.json`, {
        params: {
          login: this.username,
          api_key: this.apiKey,
          only: "id,status,error,upload_media_assets",
        },
      });
      const upload = resp.data;
      if (upload.status === "error") {
        throw new Error(`Upload ${uploadId} failed: ${upload.error || "unknown error"}`);
      }
      if (upload.status === "completed") {
        return upload;
      }
      await sleep(intervalMs);
    }
    throw new Error(`Upload ${uploadId} timed out after ${timeoutMs}ms`);
  }

  async createPost(uploadMediaAssetId, { rating, tagString = "", source = "" }) {
    const resp = await this._client().post("/posts.json", {
      upload_media_asset_id: uploadMediaAssetId,
      post: {
        rating,
        tag_string: tagString,
        source,
      },
    });
    return resp.data;
  }

  async getPost(postId) {
    const resp = await this._client().get(`/posts/${postId}.json`);
    return resp.data;
  }

  async updateTags(postId, newTagString, oldTagString = "") {
    const resp = await this._client().put(`/posts/${postId}.json`, {
      post: {
        tag_string: newTagString,
        old_tag_string: oldTagString,
      },
    });
    return resp.data;
  }
}

module.exports = { DanbooruClient, sleep };
