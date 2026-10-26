// ── JoyBoy Client-Side JavaScript ──

document.addEventListener('DOMContentLoaded', () => {
  // ── Dropdown Menu ──
  const avatarBtn = document.getElementById('avatar-btn');
  const dropdownMenu = document.getElementById('dropdown-menu');

  if (avatarBtn && dropdownMenu) {
    avatarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
      if (!dropdownMenu.contains(e.target) && !avatarBtn.contains(e.target)) {
        dropdownMenu.classList.remove('open');
      }
    });
  }

  // ── Flash Messages Auto-dismiss ──
  const flashMessage = document.getElementById('flash-message');
  if (flashMessage) {
    setTimeout(() => {
      flashMessage.style.opacity = '0';
      flashMessage.style.transform = 'translateY(-20px)';
      setTimeout(() => flashMessage.remove(), 300);
    }, 4000);
  }

  // ── File Upload: Drag & Drop + Preview ──
  const dropZone = document.getElementById('drop-zone');
  const videoInput = document.getElementById('video-input');
  const filePreview = document.getElementById('file-preview');
  const fileName = document.getElementById('file-name');
  const fileSize = document.getElementById('file-size');
  const fileRemove = document.getElementById('file-remove');

  if (dropZone && videoInput) {
    // Click to browse
    dropZone.addEventListener('click', () => videoInput.click());

    // Drag events
    ['dragenter', 'dragover'].forEach(evt => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(evt => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        videoInput.files = files;
        showFilePreview(files[0]);
      }
    });

    videoInput.addEventListener('change', () => {
      if (videoInput.files.length > 0) {
        showFilePreview(videoInput.files[0]);
      }
    });

    if (fileRemove) {
      fileRemove.addEventListener('click', () => {
        videoInput.value = '';
        filePreview.style.display = 'none';
        dropZone.style.display = '';
      });
    }
  }

  function showFilePreview(file) {
    if (!filePreview || !fileName || !fileSize) return;
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);
    filePreview.style.display = 'flex';
    dropZone.style.display = 'none';

    // Auto-fill title if empty
    const titleInput = document.getElementById('title');
    if (titleInput && !titleInput.value) {
      // Remove extension and clean up
      let name = file.name.replace(/\.[^/.]+$/, '');
      name = name.replace(/[-_]/g, ' ');
      name = name.replace(/\b\w/g, l => l.toUpperCase());
      titleInput.value = name;
    }
  }

  async function requestSignedUpload(endpoint, kind, file) {
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not prepare file upload.');
    return payload;
  }

  function uploadDirectly(uploadInfo, file, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadInfo.signedUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      if (uploadInfo.publishableKey) xhr.setRequestHeader('apikey', uploadInfo.publishableKey);
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('Storage upload failed (' + xhr.status + '). Please retry.'));
      });
      xhr.addEventListener('error', () => reject(new Error('Could not reach Supabase Storage. Check your connection and Storage configuration.')));
      xhr.addEventListener('abort', () => reject(new Error('Upload was cancelled.')));
      xhr.send(file);
    });
  }

  function createVideoThumbnail(file) {
    return new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      let finished = false;
      let duration = null;

      const cleanup = (thumbnailFile) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(objectUrl);
        resolve({ duration, thumbnailFile });
      };

      const drawFrame = () => {
        try {
          if (!video.videoWidth || !video.videoHeight) return cleanup(null);
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 360;
          const context = canvas.getContext('2d');
          const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
          const width = video.videoWidth * scale;
          const height = video.videoHeight * scale;
          context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
          canvas.toBlob((blob) => {
            if (!blob) return cleanup(null);
            cleanup(new File([blob], 'thumbnail.jpg', { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.82);
        } catch (_) {
          cleanup(null);
        }
      };

      const timeout = setTimeout(() => cleanup(null), 12000);
      video.addEventListener('error', () => cleanup(null), { once: true });
      video.addEventListener('loadedmetadata', () => {
        duration = Number.isFinite(video.duration) ? video.duration : null;
        if (duration === null || duration <= 0.05) {
          video.addEventListener('loadeddata', drawFrame, { once: true });
          return;
        }
        const target = Math.min(Math.max(duration * 0.1, 0.1), Math.max(duration - 0.1, 0));
        if (target <= 0.02) video.addEventListener('loadeddata', drawFrame, { once: true });
        else {
          video.addEventListener('seeked', drawFrame, { once: true });
          try { video.currentTime = target; } catch (_) { cleanup(null); }
        }
      }, { once: true });
      video.src = objectUrl;
      video.load();
    });
  }

  // ── Upload Form: send large media directly to Supabase Storage ──
  const uploadForm = document.getElementById('upload-form');
  const progressContainer = document.getElementById('progress-container');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const btnUploadSubmit = document.getElementById('btn-upload-submit');

  if (uploadForm && progressContainer) {
    uploadForm.addEventListener('submit', async function(event) {
      event.preventDefault();
      const videoFile = videoInput?.files?.[0];
      const title = this.querySelector('[name="title"]')?.value?.trim();
      if (!videoFile) {
        if (progressText) progressText.textContent = 'Choose a video first.';
        return;
      }
      if (!title) {
        if (progressText) progressText.textContent = 'Video title is required.';
        this.querySelector('[name="title"]')?.focus();
        return;
      }
      if (videoFile.size > 50 * 1024 * 1024) {
        if (progressText) progressText.textContent = 'Video uploads are limited to 50 MB on the current storage plan.';
        return;
      }

      const setProgress = (percent, message) => {
        if (progressFill) progressFill.style.width = percent + '%';
        if (progressText) progressText.textContent = message || (percent + '%');
      };
      progressContainer.style.display = 'flex';
      if (btnUploadSubmit) {
        btnUploadSubmit.disabled = true;
        btnUploadSubmit.textContent = 'Uploading...';
      }

      try {
        setProgress(2, 'Preparing video...');
        const thumbnailResult = await createVideoThumbnail(videoFile);
        const videoUpload = await requestSignedUpload('/videos/upload/sign', 'video', videoFile);
        setProgress(5, 'Uploading video...');
        await uploadDirectly(videoUpload, videoFile, (p) => setProgress(5 + Math.round(p * 0.8), 'Uploading video ' + p + '%'));

        let thumbnailPath = null;
        if (thumbnailResult.thumbnailFile) {
          try {
            const thumbnailUpload = await requestSignedUpload('/videos/upload/sign', 'thumbnail', thumbnailResult.thumbnailFile);
            setProgress(87, 'Saving thumbnail...');
            await uploadDirectly(thumbnailUpload, thumbnailResult.thumbnailFile);
            thumbnailPath = thumbnailUpload.path;
          } catch (thumbnailError) {
            console.warn('Thumbnail upload skipped:', thumbnailError.message);
          }
        }

        setProgress(92, 'Saving video details...');
        const completeResponse = await fetch('/videos/upload/complete', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            description: this.querySelector('[name="description"]')?.value || '',
            visibility: this.querySelector('[name="visibility"]')?.value || 'public',
            videoPath: videoUpload.path,
            thumbnailPath,
            duration: thumbnailResult.duration,
            fileSize: videoFile.size,
            mimeType: videoFile.type,
          }),
        });
        const completePayload = await completeResponse.json().catch(() => ({}));
        if (!completeResponse.ok) throw new Error(completePayload.error || 'Could not save video details.');
        setProgress(100, 'Done. Opening video...');
        window.location.assign(completePayload.redirectUrl || ('/videos/' + completePayload.videoId));
      } catch (error) {
        setProgress(0, error.message || 'Upload failed. Please try again.');
        if (btnUploadSubmit) {
          btnUploadSubmit.disabled = false;
          btnUploadSubmit.textContent = 'Upload Video';
        }
      }
    });
  }

  // ── Persist profile avatars in Supabase Storage ──
  const editProfileForm = document.getElementById('edit-profile-form');
  if (editProfileForm && avatarInput) {
    editProfileForm.addEventListener('submit', async (event) => {
      const file = avatarInput.files?.[0];
      if (!file) return;
      event.preventDefault();

      const saveButton = document.getElementById('btn-save-profile');
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
        alert('Choose a JPG, PNG, WebP, or GIF image.');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        alert('Avatar images must be smaller than 5 MB.');
        return;
      }
      if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = 'Uploading avatar...';
      }

      try {
        const userId = editProfileForm.action.match(/\\/users\\/(\\d+)\\/edit/)?.[1];
        if (!userId) throw new Error('Could not identify the profile.');
        const signed = await requestSignedUpload('/users/' + userId + '/avatar-sign', 'avatar', file);
        await uploadDirectly(signed, file);
        let avatarPath = editProfileForm.querySelector('input[name="avatarPath"]');
        if (!avatarPath) {
          avatarPath = document.createElement('input');
          avatarPath.type = 'hidden';
          avatarPath.name = 'avatarPath';
          editProfileForm.appendChild(avatarPath);
        }
        avatarPath.value = signed.path;
        avatarInput.value = '';
        HTMLFormElement.prototype.submit.call(editProfileForm);
      } catch (error) {
        alert(error.message || 'Avatar upload failed.');
        if (saveButton) {
          saveButton.disabled = false;
          saveButton.textContent = 'Save Changes';
        }
      }
    });
  }

  // ── Navbar scroll effect ──
  const navbar = document.getElementById('main-nav');
  if (navbar) {
    let lastScroll = 0;
    window.addEventListener('scroll', () => {
      const currentScroll = window.scrollY;
      if (currentScroll > 50) {
        navbar.classList.add('scrolled');
      } else {
        navbar.classList.remove('scrolled');
      }
      lastScroll = currentScroll;
    });
  }

  // ── Mobile Search Experience & Recent Searches History ──
  const mobileSearchBtn = document.getElementById('mobile-search-btn');
  const mobileSearchOverlay = document.getElementById('mobile-search-overlay');
  const mobileSearchBackBtn = document.getElementById('mobile-search-back-btn');
  const mobileSearchForm = document.getElementById('mobile-search-form');
  const mobileSearchInput = document.getElementById('mobile-search-input');
  const mobileSearchClearBtn = document.getElementById('mobile-search-clear-btn');
  const mobileRecentSearches = document.getElementById('mobile-recent-searches');
  const recentSearchesList = document.getElementById('recent-searches-list');
  const recentClearAllBtn = document.getElementById('recent-clear-all-btn');

  const STORAGE_KEY = 'joyboy_recent_searches';
  const MAX_RECENT_SEARCHES = 8;

  function getRecentSearches() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecentSearch(query) {
    if (!query || !query.trim()) return;
    const trimmed = query.trim();
    let searches = getRecentSearches();
    // Remove if already exists to bump to top (newest first)
    searches = searches.filter(item => item.toLowerCase() !== trimmed.toLowerCase());
    searches.unshift(trimmed);
    if (searches.length > MAX_RECENT_SEARCHES) {
      searches = searches.slice(0, MAX_RECENT_SEARCHES);
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(searches));
    } catch (e) {}
  }

  function removeRecentSearch(query) {
    let searches = getRecentSearches();
    searches = searches.filter(item => item !== query);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(searches));
    } catch (e) {}
    renderRecentSearches();
  }

  function clearAllRecentSearches() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    renderRecentSearches();
  }

  function renderRecentSearches() {
    if (!mobileRecentSearches || !recentSearchesList) return;
    const searches = getRecentSearches();
    if (!searches || searches.length === 0) {
      mobileRecentSearches.style.display = 'none';
      recentSearchesList.innerHTML = '';
      return;
    }

    mobileRecentSearches.style.display = 'flex';
    recentSearchesList.innerHTML = '';

    searches.forEach(query => {
      const li = document.createElement('li');
      li.className = 'recent-search-item';

      const queryBtn = document.createElement('button');
      queryBtn.type = 'button';
      queryBtn.className = 'recent-search-query-btn';
      queryBtn.innerHTML = `
        <svg class="recent-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <span class="recent-search-text"></span>
      `;
      queryBtn.querySelector('.recent-search-text').textContent = query;
      queryBtn.addEventListener('click', () => {
        saveRecentSearch(query);
        if (mobileSearchInput) mobileSearchInput.value = query;
        if (mobileSearchForm) mobileSearchForm.submit();
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'recent-search-remove-btn';
      removeBtn.setAttribute('aria-label', `Remove "${query}" from history`);
      removeBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      `;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeRecentSearch(query);
      });

      li.appendChild(queryBtn);
      li.appendChild(removeBtn);
      recentSearchesList.appendChild(li);
    });
  }

  function updateClearBtnState() {
    if (!mobileSearchInput || !mobileSearchClearBtn) return;
    if (mobileSearchInput.value.length > 0) {
      mobileSearchClearBtn.classList.add('visible');
    } else {
      mobileSearchClearBtn.classList.remove('visible');
    }
  }

  function openMobileSearch(pushState = true) {
    if (!mobileSearchOverlay) return;
    mobileSearchOverlay.classList.add('open');
    mobileSearchOverlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('search-overlay-open');
    renderRecentSearches();
    updateClearBtnState();

    if (pushState) {
      history.pushState({ joyboyMobileSearch: true }, '');
    }

    setTimeout(() => {
      if (mobileSearchInput) {
        mobileSearchInput.focus();
        if (mobileSearchInput.value) {
          mobileSearchInput.select();
        }
      }
    }, 50);
  }

  function closeMobileSearch(popHistory = false) {
    if (!mobileSearchOverlay) return;
    mobileSearchOverlay.classList.remove('open');
    mobileSearchOverlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('search-overlay-open');

    if (popHistory && history.state && history.state.joyboyMobileSearch) {
      history.back();
    }
  }

  if (mobileSearchBtn) {
    mobileSearchBtn.addEventListener('click', () => {
      openMobileSearch(true);
    });
  }

  if (mobileSearchBackBtn) {
    mobileSearchBackBtn.addEventListener('click', () => {
      if (history.state && history.state.joyboyMobileSearch) {
        history.back();
      } else {
        closeMobileSearch(false);
      }
    });
  }

  window.addEventListener('popstate', (e) => {
    if (mobileSearchOverlay && mobileSearchOverlay.classList.contains('open')) {
      if (!e.state || !e.state.joyboyMobileSearch) {
        closeMobileSearch(false);
      }
    }
  });

  if (mobileSearchInput) {
    mobileSearchInput.addEventListener('input', updateClearBtnState);
  }

  if (mobileSearchClearBtn) {
    mobileSearchClearBtn.addEventListener('click', () => {
      if (mobileSearchInput) {
        mobileSearchInput.value = '';
        updateClearBtnState();
        mobileSearchInput.focus();
      }
    });
  }

  if (recentClearAllBtn) {
    recentClearAllBtn.addEventListener('click', clearAllRecentSearches);
  }

  if (mobileSearchForm) {
    mobileSearchForm.addEventListener('submit', () => {
      if (mobileSearchInput && mobileSearchInput.value.trim()) {
        saveRecentSearch(mobileSearchInput.value.trim());
      }
    });
  }

  // Save query to localStorage when desktop search is used
  const desktopSearchForm = document.getElementById('search-form');
  const desktopSearchInput = document.getElementById('search-input');
  if (desktopSearchForm && desktopSearchInput) {
    desktopSearchForm.addEventListener('submit', () => {
      if (desktopSearchInput.value.trim()) {
        saveRecentSearch(desktopSearchInput.value.trim());
      }
    });
  }
});

// ── Utility ──
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}
