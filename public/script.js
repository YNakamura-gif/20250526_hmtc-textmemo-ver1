// ======================================================================
// 1. Firebase Configuration & Initialization
// ======================================================================
const firebaseConfig = {
  apiKey: "AIzaSyCnBdrB7Ezvdw81OMOBP_Jy4LhOzJ83V3A",
  authDomain: "text-memo-ver1.firebaseapp.com",
  databaseURL: "https://text-memo-ver1-default-rtdb.firebaseio.com",
  projectId: "text-memo-ver1",
  storageBucket: "text-memo-ver1.appspot.com", //修正：提供された情報に合わせる（.appspot.comが一般的）
  messagingSenderId: "25236892746",
  appId: "1:25236892746:web:8b6ea45a19904e313f0ab3",
  measurementId: "G-S3Q4Q6H43Q"
};

firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// ======================================================================
// 2. Global State & Prediction Data Storage
// ======================================================================
let locationPredictions = [];
let degradationItemsData = []; // 新しい劣化項目データ用

let currentProjectId = null;
let currentBuildingId = null;
let buildings = {};
let lastUsedBuilding = null;
let deteriorationData = {};
let deteriorationListeners = {};
let currentEditRecordId = null;
let lastAddedLocation = '';
let lastAddedName = '';
let lastAddedPhotoNumber = ''; // ★ 追加: 連続登録用に直前の写真番号を記憶
let buildingsListener = null; // Firebase listener for buildings

// ======================================================================
// 3. Firebase Reference Getters
// ======================================================================
function getProjectBaseRef(projectId) {
  return database.ref(`projects/${projectId}`);
}
function getProjectInfoRef(projectId) {
  return database.ref(`projects/${projectId}/info`);
}
function getBuildingsRef(projectId) {
  return database.ref(`projects/${projectId}/buildings`);
}
function getDeteriorationsRef(projectId, buildingId) {
  return database.ref(`projects/${projectId}/buildings/${buildingId}/deteriorations`);
}
function getDeteriorationCounterRef(projectId, buildingId) {
  return database.ref(`projects/${projectId}/counters/${buildingId}`);
}
// ★ 追加: 写真番号カウンター用の参照
function getPhotoCounterRef(projectId, buildingId) {
    return database.ref(`projects/${projectId}/photoCounters/${buildingId}`);
}

// ======================================================================
// 4. Utility Functions
// ======================================================================
function generateProjectId(siteName) {
    if (!siteName) return null;
    const safeSiteName = siteName.replace(/[.#$\[\]]/g, '_'); 
    return safeSiteName;
}

function generateBuildingId(buildingName) {
    if (!buildingName) return null;
    const safeBuildingName = buildingName.replace(/[.#$\[\]]/g, '_').substring(0, 50); 
    return safeBuildingName;
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
 }

// ★ NEW: Katakana to Hiragana converter function
function katakanaToHiragana(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[ァ-ヶ]/g, match => {
    const chr = match.charCodeAt(0) - 0x60;
    return String.fromCharCode(chr);
  });
}

// ★ NEW: Full-width numbers to Half-width converter function
function zenkakuToHankaku(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[０-９]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });
}

// ★ NEW: Enforce half-width digits only in an input field
function enforceHalfWidthDigits(inputElement) {
  if (!inputElement) return;
  inputElement.addEventListener('input', () => {
    let value = inputElement.value;
    // Convert full-width numbers to half-width
    value = zenkakuToHankaku(value);
    // Remove non-digit characters
    value = value.replace(/[^0-9]/g, '');
    // Update the input field value only if it changed
    if (inputElement.value !== value) {
        inputElement.value = value;
    }
  });
}

// ======================================================================
// 5. Data Loading/Parsing (CSV, Predictions)
// ======================================================================
function parseCsv(csvText, expectedColumns) {
  console.log("[parseCsv] Starting parse. Expected columns:", expectedColumns);
  console.log("[parseCsv] Received text (first 100 chars):", csvText.substring(0, 100)); // ★ 追加：受け取ったテキストの先頭を表示
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length <= 1) {
    console.warn("CSV file has no data or only a header.");
    return [];
  }
  const header = lines.shift().split(',');
  console.log("[parseCsv] Header:", header);
  if (header.length < expectedColumns) {
      console.warn(`CSV header has fewer columns (${header.length}) than expected (${expectedColumns}).`);
  }

  return lines.map((line, index) => { // ★ 追加：行番号もログ
    const values = line.split(',');
    console.log(`[parseCsv] Line ${index + 1} values:`, values); // ★ 追加：パースした各行の配列を表示
    if (expectedColumns === 3 && header[0] === '階数') { // ヘッダーで場所CSVかを判断
      const floor = values[0]?.trim() || ''; // 階数がない場合は空文字に
      const value = values[1]?.trim(); // 部屋名
      const reading = values[2]?.trim(); // 読み
      // 部屋名があれば有効なデータとする
      return value ? { floor: floor, value: value, reading: reading || '' } : null;
    }
    // ★ 劣化項目CSV (3列想定) の処理
    else if (expectedColumns === 3 && header[0] === '劣化名') { // ★ header[0]が劣化名の場合を追加
      const name = values[0]?.trim();
      const code = values[1]?.trim();
      const reading = values[2]?.trim();
      return name ? { name: name, code: code || '', reading: reading || '' } : null;
    } else {
      console.warn(`Unsupported expectedColumns or unknown CSV format: ${expectedColumns}, Header: ${header[0]}`);
      return null;
    }
  }).filter(item => item !== null);
}

async function fetchAndParseCsv(filePath, expectedColumns) { 
  console.log(`Fetching CSV from: ${filePath}`);
  try {
    const response = await fetch(filePath);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} for ${filePath}`);
    }
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('utf-8');
    let text = decoder.decode(buffer);
    console.log(`[fetchAndParseCsv] Decoded text (first 200 chars) from ${filePath}:`, text.substring(0, 200)); // ★ 追加：デコード直後のテキストを表示
    console.log(`[fetchAndParseCsv] First char code: ${text.charCodeAt(0)} (BOM check: 65279 is BOM)`); // ★ 追加：BOM確認用ログ
    if (text.charCodeAt(0) === 0xFEFF) {
      console.log("[fetchAndParseCsv] BOM detected and removed."); // ★ 追加
      text = text.slice(1);
    }
    return parseCsv(text, expectedColumns); 
  } catch (error) {
    console.error(`Error fetching or parsing CSV ${filePath}:`, error);
    return [];
  }
}

async function loadPredictionData() {
  console.log("Loading prediction data...");
  try {
    // Promise.all を使って並列読み込み
    [locationPredictions, degradationItemsData] = await Promise.all([
      fetchAndParseCsv('./部屋名_読み付き.csv', 3),       // ★ 変更: 場所データは3列期待
      fetchAndParseCsv('./劣化項目_読み付き.csv', 3)     // 劣化項目データは3列期待
    ]);
    // 古い部位・劣化名のログを削除
    console.log(`Loaded ${locationPredictions.length} location predictions (Rooms with Floor).`);
    console.log(`Loaded ${degradationItemsData.length} degradation items (Name, Code, Reading).`);
    // degradationItemsData の内容を少し表示して確認 (デバッグ用)
    console.log("Sample degradationItemsData:", degradationItemsData.slice(0, 5)); 
  } catch (error) {
    console.error("Critical error loading prediction data:", error);
    alert("予測変換データの読み込みに失敗しました。アプリケーションが正しく動作しない可能性があります。");
  }
}

// ======================================================================
// 6. Prediction Logic Functions
// ======================================================================

// ★ COMBINED RESULTS generateLocationPredictions function
function generateLocationPredictions(inputText) {
  console.log(`[generateLocationPredictions] Input: \"${inputText}\"`);

  // ★ 1. Convert full-width numbers to half-width in the input
  const inputTextHankaku = zenkakuToHankaku(inputText.trim());
  console.log(`[generateLocationPredictions] Input after Hankaku conversion: \"${inputTextHankaku}\"`);

  let floorSearchTerm = null;
  let roomSearchTermRaw = inputTextHankaku;
  let roomSearchTermHiragana = '';

  // Regex to detect floor prefix (e.g., 1, B1, PH)
  const floorMatch = roomSearchTermRaw.match(/^([a-zA-Z0-9]{1,3})(.*)$/);

  if (floorMatch && floorMatch[1] && floorMatch[2]) {
    floorSearchTerm = floorMatch[1].toLowerCase();
    roomSearchTermRaw = floorMatch[2];
    console.log(`[generateLocationPredictions] Floor search term: '${floorSearchTerm}', Room search term raw: '${roomSearchTermRaw}'`);
  } else if (roomSearchTermRaw.match(/^[a-zA-Z0-9]{1,3}$/)) {
      floorSearchTerm = roomSearchTermRaw.toLowerCase();
      roomSearchTermRaw = '';
      console.log(`[generateLocationPredictions] Input is potentially floor only: '${floorSearchTerm}'`);
  } else {
    console.log("[generateLocationPredictions] No floor prefix detected in input.");
  }

  roomSearchTermHiragana = katakanaToHiragana(roomSearchTermRaw.toLowerCase());

  if (!roomSearchTermHiragana && !floorSearchTerm) {
      console.log("[generateLocationPredictions] No valid search term.");
      return [];
  }

  // ★ 2. Find matching floors from CSV
  let matchingFloors = [];
  const floorSet = new Set(); // Use Set to avoid duplicates
  if (floorSearchTerm !== null) {
    locationPredictions.forEach(item => {
      const itemFloorLower = item.floor?.toLowerCase() || '';
      if (itemFloorLower.startsWith(floorSearchTerm)) {
        floorSet.add(item.floor); // Add the original floor string (not lowercase)
      }
    });
    matchingFloors = Array.from(floorSet);
    console.log(`[generateLocationPredictions] Found ${matchingFloors.length} matching floors in CSV:`, matchingFloors);
  } else {
    // If no floor search term, we only search based on room name later.
    // We don't add [''] here anymore, as it complicates combination logic.
    console.log(`[generateLocationPredictions] No floor search term, will search by room name only.`);
  }

  // ★ 3. Find matching room names from CSV
  let matchingRoomNames = [];
  const roomNameSet = new Set(); // Use Set to avoid duplicates

  if (roomSearchTermHiragana) {
    // If a room name part is entered, find rooms matching the reading
    locationPredictions.forEach(item => {
      const itemReadingHiragana = katakanaToHiragana(item.reading?.toLowerCase() || '');
      if (itemReadingHiragana.startsWith(roomSearchTermHiragana)) {
        if (item.value) roomNameSet.add(item.value); // Add the room name if it exists
      }
    });
    matchingRoomNames = Array.from(roomNameSet);
    console.log(`[generateLocationPredictions] Found ${matchingRoomNames.length} matching room names based on reading:`, matchingRoomNames);

  } else if (floorSearchTerm !== null) {
    // <<<<< MODIFIED LOGIC >>>>>
    // If ONLY floor is entered, get ALL unique room names from the CSV
    console.log('[generateLocationPredictions] Floor term entered, collecting all unique room names.');
    locationPredictions.forEach(item => {
      if (item.value) { // Ensure room name exists
        roomNameSet.add(item.value);
      }
    });
    matchingRoomNames = Array.from(roomNameSet);
    console.log(`[generateLocationPredictions] Collected ${matchingRoomNames.length} unique room names from CSV.`);
    // <<<<< END MODIFIED LOGIC >>>>>

  } else {
    // No floor or room search term (should not happen due to check at the beginning)
    console.log('[generateLocationPredictions] No floor or room search term, no room name matches generated.');
  }

  // ★ 4. Generate all combinations
  let combinations = [];

  // Add matching floors themselves as candidates if no room name was specifically searched
  if (!roomSearchTermHiragana && floorSearchTerm) {
    matchingFloors.forEach(floor => {
        if (floor) { // Ensure floor is not empty
            combinations.push(floor);
        }
    });
  }

  // Generate floor + room name combinations
  for (const floor of matchingFloors) {
      if (!floor) continue; // Skip if floor is empty
      for (const roomName of matchingRoomNames) {
         if (!roomName) continue; // Skip if room name is empty
          // Only add combination if floor was part of the search OR room name was part of search
         if (floorSearchTerm || roomSearchTermHiragana) {
              combinations.push(`${floor} ${roomName}`);
         }
      }
  }

  // If only a room name was searched (no floor), ensure room names themselves are included
  if (!floorSearchTerm && roomSearchTermHiragana) {
       matchingRoomNames.forEach(room => {
           if (room) combinations.push(room);
       });
  }


  console.log(`[generateLocationPredictions] Generated ${combinations.length} raw combinations`);
  if (combinations.length > 0) console.log("[generateLocationPredictions] Raw combinations sample:", combinations.slice(0, 10));


  // Remove duplicates and limit
  const uniqueCombinations = [...new Set(combinations)];
  console.log(`[generateLocationPredictions] Final unique combinations count: ${uniqueCombinations.length}`);
  if (uniqueCombinations.length > 0) console.log("[generateLocationPredictions] Final unique combinations sample:", uniqueCombinations.slice(0, 10));


  // Return up to 10 combinations
  return uniqueCombinations.slice(0, 10);
}

function generateDegradationPredictions(inputText) {
  // console.log(`[generateDegradationPredictions] Input: \"${inputText}\"`);
  if (!inputText || inputText.trim().length < 1) {
    return []; // Return empty if input is too short or empty
  }

  const searchTermLower = inputText.trim().toLowerCase();
  const searchTermHiragana = katakanaToHiragana(searchTermLower);
  const isTwoCharInput = searchTermHiragana.length === 2;
  // console.log(`[generateDegradationPredictions] Search terms: lower='${searchTermLower}', hiragana='${searchTermHiragana}', isTwoChar=${isTwoCharInput}`);

  // ★ 修正: 優先度別にマッチ結果を収集
  let readingPrefixMatches = [];
  let nameMatches = [];
  let codeMatches = [];

  degradationItemsData.forEach(item => {
    const itemNameLower = item.name?.toLowerCase() || '';
    const itemReadingRaw = item.reading || ''; 
    const itemCodeHiragana = katakanaToHiragana(item.code?.toLowerCase() || '');

    // 1. 読み仮名前方一致チェック
    const readingParts = itemReadingRaw.split(' ');
    let isReadingPrefixMatch = false;
    for (const part of readingParts) {
      const partHiragana = katakanaToHiragana(part.toLowerCase());
      if (partHiragana.startsWith(searchTermHiragana)) {
        isReadingPrefixMatch = true;
        break;
      }
    }
    if (isReadingPrefixMatch) {
      readingPrefixMatches.push(item.name);
    }

    // 2. 劣化名部分一致チェック (読み仮名と重複しないように)
    if (!isReadingPrefixMatch && itemNameLower.includes(searchTermLower)) {
      nameMatches.push(item.name);
    }

    // 3. 2文字コード完全一致チェック (読み仮名・名前とも重複しないように)
    if (!isReadingPrefixMatch && !itemNameLower.includes(searchTermLower) && 
        isTwoCharInput && itemCodeHiragana && itemCodeHiragana === searchTermHiragana) {
      codeMatches.push(item.name);
    }
  });

  // ★ 修正: 優先度順に結合し、重複を除去して最大10件返す
  const combined = [...readingPrefixMatches, ...nameMatches, ...codeMatches];
  const uniquePredictions = [...new Set(combined)];

  // console.log(`[generateDegradationPredictions] Returning ${uniquePredictions.length} unique predictions:`, uniquePredictions.slice(0, 10));
  return uniquePredictions.slice(0, 10);
}

function showPredictions(inputElement, predictionListElement, predictions) {
  predictionListElement.innerHTML = ''; // Clear previous predictions

  if (predictions.length > 0) {
    predictions.forEach(prediction => {
      const li = document.createElement('li');
      li.textContent = prediction;
      li.setAttribute('tabindex', '-1');
      li.classList.add('px-3', 'py-1', 'cursor-pointer', 'hover:bg-blue-100', 'list-none', 'text-sm');

      // Restore touchend event listener
      li.addEventListener('touchend', (e) => {
        e.preventDefault();
        inputElement.value = prediction;

        // ★ Restore simple hidePredictions call
        hidePredictions(predictionListElement);

        let nextFocusElement = null;
        if (inputElement.id === 'locationInput') {
          nextFocusElement = document.getElementById('deteriorationNameInput');
        } else if (inputElement.id === 'deteriorationNameInput') {
          nextFocusElement = document.getElementById('photoNumberInput');
        } else if (inputElement.id === 'editLocationInput') {
          nextFocusElement = document.getElementById('editDeteriorationNameInput');
        } else if (inputElement.id === 'editDeteriorationNameInput') {
          nextFocusElement = document.getElementById('editPhotoNumberInput');
        }

        if (nextFocusElement) {
          // ★ Restore focus/click attempt with timeout 0
          setTimeout(() => {
            nextFocusElement.focus();
            nextFocusElement.click();
          }, 0);
        }
      });
      predictionListElement.appendChild(li);
    });
    predictionListElement.classList.remove('hidden');
  } else {
    hidePredictions(predictionListElement);
  }
}

function hidePredictions(predictionListElement) {
  predictionListElement.classList.add('hidden');
}

function setupPredictionListeners(inputElement, predictionListElement, generatorFn, nextElementId) {
  if (!inputElement || !predictionListElement) {
      console.warn("setupPredictionListeners: Input or List element not found.");
      return;
  }

  inputElement.addEventListener('input', () => {
    const inputText = inputElement.value;
    if (inputText.trim()) {
        const predictions = generatorFn(inputText);
        showPredictions(inputElement, predictionListElement, predictions);
    } else {
        hidePredictions(predictionListElement);
    }
  });

  // Restore original blur listener
  inputElement.addEventListener('blur', () => {
    setTimeout(() => hidePredictions(predictionListElement), 200);
  });

  inputElement.addEventListener('focus', () => {
    const inputText = inputElement.value;
    if (inputText.trim()) {
      const predictions = generatorFn(inputText);
      if (predictions.length > 0) {
          showPredictions(inputElement, predictionListElement, predictions);
      }
    }
  });

  // ★★★ Enterキーでのフォーカス移動リスナーを追加 ★★★
  if (nextElementId) { // 次の要素のIDが指定されている場合のみ
    inputElement.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault(); // デフォルトのEnter動作（フォーム送信など）を抑制
        hidePredictions(predictionListElement); // 予測リストを隠す
        const nextElement = document.getElementById(nextElementId);
        if (nextElement) {
          nextElement.focus(); // 次の要素にフォーカス
        }
      }
    });
  }
  // ★★★ ここまで ★★★
}

// ======================================================================
// 7. UI Update Functions
// ======================================================================
function switchTab(activeTabId, infoTabBtn, detailTabBtn, infoTab, detailTab) {
  if (activeTabId === 'info') {
    infoTab.classList.remove('hidden');
    detailTab.classList.add('hidden');
    infoTabBtn.classList.add('bg-blue-600', 'text-white');
    infoTabBtn.classList.remove('bg-gray-200', 'text-gray-700');
    detailTabBtn.classList.add('bg-gray-200', 'text-gray-700');
    detailTabBtn.classList.remove('bg-blue-600', 'text-white');
  } else if (activeTabId === 'detail') {
    detailTab.classList.remove('hidden');
    infoTab.classList.add('hidden');
    detailTabBtn.classList.add('bg-blue-600', 'text-white');
    detailTabBtn.classList.remove('bg-gray-200', 'text-gray-700');
    infoTabBtn.classList.add('bg-gray-200', 'text-gray-700');
    infoTabBtn.classList.remove('bg-blue-600', 'text-white');
  }
  localStorage.setItem('lastActiveTabId', activeTabId); // ★ 追加: タブ状態を保存
  console.log(`[switchTab] Switched to ${activeTabId} and saved state.`);
}

async function updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement) {
  if (!projectId || !buildingId) {
    nextIdDisplayElement.textContent = '1';
    return;
  }
  try {
    const snapshot = await getDeteriorationCounterRef(projectId, buildingId).once('value');
    const currentCounter = snapshot.val() || 0;
    nextIdDisplayElement.textContent = (currentCounter + 1).toString();
  } catch (error) {
    console.error("Error fetching counter for next ID display:", error);
    nextIdDisplayElement.textContent = '-'; 
  }
}

function renderDeteriorationTable(recordsToRender, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
    if (!deteriorationTableBodyElement) return;
    deteriorationTableBodyElement.innerHTML = ''; // Clear existing rows

    if (recordsToRender.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5; // Span all columns
        td.textContent = '登録データがありません。';
        td.classList.add('text-center', 'py-4', 'text-gray-500');
        tr.appendChild(td);
        deteriorationTableBodyElement.appendChild(tr);
        return;
    }

    recordsToRender.forEach(record => {
        const tr = document.createElement('tr');
        tr.classList.add('border-b');
        tr.innerHTML = `
            <td class="py-0 px-2 text-center text-sm">${escapeHtml(record.number)}</td>
            <td class="py-0 px-2 text-sm">
                <div class="cell-truncate" title="${escapeHtml(record.location)}">
                    ${escapeHtml(record.location)}
                </div>
            </td>
            <td class="py-0 px-2 text-sm">
                <div class="cell-truncate" title="${escapeHtml(record.name)}">
                    ${escapeHtml(record.name)}
                </div>
            </td>
            <td class="py-0 px-2 text-center text-sm">${escapeHtml(record.photoNumber)}</td>
            <td class="py-0 px-1 text-center whitespace-nowrap">
                <button class="edit-btn bg-green-500 hover:bg-green-600 text-white py-1 px-2 rounded text-sm">編集</button>
                <button class="delete-btn bg-red-500 hover:bg-red-600 text-white py-1 px-2 rounded text-sm">削除</button>
            </td>
        `;
        // Add event listeners for edit and delete buttons
        const editBtn = tr.querySelector('.edit-btn');
        const deleteBtn = tr.querySelector('.delete-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => handleEditClick(currentProjectId, currentBuildingId, record.id, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput));
        }
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => handleDeleteClick(currentProjectId, currentBuildingId, record.id, record.number));
        }
        deteriorationTableBodyElement.appendChild(tr);
    });
}

// ======================================================================
// 8. Data Loading - Building List & Deteriorations
// ======================================================================
// ★ 修正: 引数に lastAddedBuildingId を追加し、その建物を選択状態にする
async function updateBuildingSelectorForProject(projectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, buildingIdToSelect = null) {
  if (!projectId) {
    console.warn("[updateBuildingSelectorForProject] No projectId provided.");
    buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
    buildingSelectElement.disabled = true;
    activeBuildingNameSpanElement.textContent = '未選択';
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    updateNextIdDisplay(null, null, nextIdDisplayElement);
    currentBuildingId = null;
    return;
  }
  console.log(`[updateBuildingSelectorForProject] Updating buildings for project ${projectId}`);
  const buildingsRef = getBuildingsRef(projectId);
  buildingSelectElement.innerHTML = '<option value="">読み込み中...</option>';
  buildingSelectElement.disabled = true;

  try {
    console.log(`[updateBuildingSelectorForProject] Attempting to fetch buildings from Firebase for ${projectId}`); // ★ 追加ログ
    const snapshot = await buildingsRef.once('value');
    console.log(`[updateBuildingSelectorForProject] Firebase snapshot received. Exists: ${snapshot.exists()}`); // ★ 追加ログ
    const buildingsData = snapshot.val();
    console.log(`[updateBuildingSelectorForProject] Raw buildingsData:`, buildingsData); // ★ 追加ログ: 取得した生データを表示

    const buildingEntries = buildingsData ? Object.entries(buildingsData) : [];
    console.log(`[updateBuildingSelectorForProject] Processed buildingEntries count: ${buildingEntries.length}`); // ★ 追加ログ

    if (buildingEntries.length > 0) {
      console.log('[updateBuildingSelectorForProject] Building entries found. Populating selector...'); // ★ 追加ログ
      buildingSelectElement.innerHTML = '<option value="">-- 建物を選択 --</option>';
      // ★ 敷地(site)を常に最初に表示するためのソートロジック
      buildingEntries.sort(([idA, dataA], [idB, dataB]) => {
          if (idA === 'site') return -1;
          if (idB === 'site') return 1;
          // 敷地以外は名前でソート (例: A棟, B棟...)
          const nameA = dataA.name || '';
          const nameB = dataB.name || '';
          return nameA.localeCompare(nameB, 'ja');
      });
      console.log('[updateBuildingSelectorForProject] Buildings sorted.'); // ★ 追加ログ
      
      buildingEntries.forEach(([buildingId, buildingData], index) => { // ★ index を追加
        try { // ★ ループ内に try を追加
          // console.log(`[updateBuildingSelectorForProject] Adding option: ID=${buildingId}, Name=${buildingData?.name}`); // ★ 必要なら追加
          const option = document.createElement('option');
          option.value = buildingId;
          // ★ 修正: buildingDataが存在しない、またはnameがない場合のフォールバックを強化
          option.textContent = buildingData?.name || `建物 (${buildingId})`; 
          buildingSelectElement.appendChild(option);
        } catch(loopError) { // ★ ループ内エラーを捕捉
            console.error(`[updateBuildingSelectorForProject] <<<< ERROR in loop >>>> Error adding option for building index ${index}, ID=${buildingId}:`, loopError);
            // ★ エラーが発生してもループは継続するが、問題があったことをログに残す
        }
      });
      buildingSelectElement.disabled = false;
      console.log('[updateBuildingSelectorForProject] Selector populated and enabled.'); // ★ 追加ログ

      // Determine which building to select
      let selectedBuildingId = null;
      console.log(`[updateBuildingSelectorForProject] Determining selection. ID to select hint: ${buildingIdToSelect}, Current ID: ${currentBuildingId}, Last used: ${lastUsedBuilding}`); // ★ 追加ログ
      if (buildingIdToSelect && buildingSelectElement.querySelector(`option[value="${buildingIdToSelect}"]`)) {
          selectedBuildingId = buildingIdToSelect;
          console.log(`[updateBuildingSelectorForProject] Selecting specified building: ${selectedBuildingId}`);
      } else if (currentBuildingId && buildingSelectElement.querySelector(`option[value="${currentBuildingId}"]`)) {
          selectedBuildingId = currentBuildingId;
          console.log(`[updateBuildingSelectorForProject] Maintaining current building: ${selectedBuildingId}`);
      } else if (lastUsedBuilding && buildingSelectElement.querySelector(`option[value="${lastUsedBuilding}"]`)) {
          selectedBuildingId = lastUsedBuilding;
          console.log(`[updateBuildingSelectorForProject] Restoring last used building: ${selectedBuildingId}`);
      } else {
          const firstOption = buildingSelectElement.querySelector('option:not([value=""])');
          if (firstOption) {
              selectedBuildingId = firstOption.value;
              console.log(`[updateBuildingSelectorForProject] Selecting first available building: ${selectedBuildingId}`);
          }
      }
      console.log(`[updateBuildingSelectorForProject] Final selectedBuildingId: ${selectedBuildingId}`); // ★ 追加ログ
      
      if (selectedBuildingId) {
          buildingSelectElement.value = selectedBuildingId;
          currentBuildingId = selectedBuildingId;
          lastUsedBuilding = selectedBuildingId; 
          localStorage.setItem('lastBuildingId', currentBuildingId);
          activeBuildingNameSpanElement.textContent = buildingSelectElement.options[buildingSelectElement.selectedIndex]?.text || '不明';
          await fetchAndRenderDeteriorations(projectId, currentBuildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
      } else {
          console.log('[updateBuildingSelectorForProject] No building could be selected.'); // ★ 追加ログ
          activeBuildingNameSpanElement.textContent = '未選択';
          renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
          updateNextIdDisplay(projectId, null, nextIdDisplayElement);
          currentBuildingId = null;
      }
      
    } else {
      console.log('[updateBuildingSelectorForProject] No building entries found after fetch.'); // ★ 追加ログ
      // 建物データがない場合
      buildingSelectElement.innerHTML = '<option value="">-- 建物未登録 --</option>';
      activeBuildingNameSpanElement.textContent = '未登録';
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
      updateNextIdDisplay(projectId, null, nextIdDisplayElement);
      currentBuildingId = null;
    }
  } catch (error) {
    // ★★★★★ CATCH BLOCK ENTERED ★★★★★
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("[updateBuildingSelectorForProject] <<<< CATCH BLOCK EXECUTED >>>>");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    // ★★★★★★★★★★★★★★★★★★★★★★
    console.error(`[updateBuildingSelectorForProject] <<<< ERROR >>>> Error fetching or processing buildings for project ${projectId}:`);
    // エラーオブジェクト全体、メッセージ、スタックトレースを出力
    console.error("Error Object:", error);
    console.error("Error Message:", error.message);
    console.error("Error Name:", error.name);
    console.error("Error Stack:", error.stack);
    // ★★★★★★★★★★★★★★★★★★★★★★
    buildingSelectElement.innerHTML = '<option value="">読み込みエラー</option>';
    activeBuildingNameSpanElement.textContent = 'エラー';
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    updateNextIdDisplay(null, null, nextIdDisplayElement);
    currentBuildingId = null;
  }
}

// ======================================================================
// 9. Data Loading - Basic Info
// ======================================================================
async function loadBasicInfo(projectId, siteNameInput) { 
  console.log(`[loadBasicInfo] Loading basic info for project ID: ${projectId}`);
  const infoRef = getProjectInfoRef(projectId);
  try {
    const snapshot = await infoRef.once('value');
    const info = snapshot.val();
    if (info) {
      console.log("[loadBasicInfo] Found info:", info);
      siteNameInput.value = info.siteName || '';
    } else {
      console.log("[loadBasicInfo] No info found for this project.");
      siteNameInput.value = '';
    }
  } catch (error) {
    console.error("Error loading basic info:", error);
    siteNameInput.value = '';
  }
}

// ======================================================================
// NEW Utility: Manage Recent Project List in localStorage
// ======================================================================
const MAX_RECENT_PROJECTS = 10; // Maximum number of recent projects to store
const RECENT_PROJECTS_KEY = 'recentProjectNames';

function getRecentProjectNames() {
  try {
    const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.error("Error reading recent projects from localStorage:", e);
    return [];
  }
}

function addProjectToRecentList(siteName) {
  if (!siteName) return;
  let recentNames = getRecentProjectNames();
  // Remove the name if it already exists to move it to the front
  recentNames = recentNames.filter(name => name !== siteName);
  // Add the new name to the beginning
  recentNames.unshift(siteName);
  // Limit the list size
  recentNames = recentNames.slice(0, MAX_RECENT_PROJECTS);
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recentNames));
    console.log(`[addProjectToRecentList] Updated recent projects:`, recentNames);
  } catch (e) {
    console.error("Error saving recent projects to localStorage:", e);
  }
}

// ======================================================================
// NEW Utility: Update Datalist with Sorted Options
// ======================================================================
function updateDatalistWithOptions(allProjectNames, projectDataListElement) {
  if (!projectDataListElement) return;

  const recentNames = getRecentProjectNames();
  const recentSet = new Set(recentNames); // For efficient lookup

  // Ensure allProjectNames is an array of unique names
  const uniqueAllProjectNames = [...new Set(allProjectNames)];

  // Separate recent names present in allProjectNames and other names
  const validRecentNames = recentNames.filter(name => uniqueAllProjectNames.includes(name));
  const otherNames = uniqueAllProjectNames
    .filter(name => !recentSet.has(name))
    .sort((a, b) => a.localeCompare(b, 'ja')); // Sort remaining names alphabetically (Japanese)

  // Combine: valid recent first, then others. Ensure uniqueness again just in case.
  const finalSortedNames = [...new Set([...validRecentNames, ...otherNames])];

  // Update the datalist
  projectDataListElement.innerHTML = ''; // Clear existing options
  finalSortedNames.forEach(projectName => {
    const option = document.createElement('option');
    option.value = projectName;
    projectDataListElement.appendChild(option);
  });
  // console.log("[updateDatalistWithOptions] Datalist updated with sorted names:", finalSortedNames.slice(0, 5)); // Log first few
}

// ======================================================================
// 9. Data Loading - Project List (Modified)
// ======================================================================
async function populateProjectDataList(projectDataListElement) {
  console.log("[populateProjectDataList] Populating project data list...");
  const CACHE_KEY = 'projectDataListCache';
  const CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes cache expiry

  try {
    const cachedData = localStorage.getItem(CACHE_KEY);
    if (cachedData) {
      const { timestamp, data } = JSON.parse(cachedData);
      if (Date.now() - timestamp < CACHE_EXPIRY) {
        console.log("[populateProjectDataList] Using cached project list.");
        return data; // Return cached data (already unique from previous save)
      }
    }
  } catch (e) {
    console.error("Error reading project list cache:", e);
    // Proceed to fetch fresh data if cache read fails
  }

  console.log("[populateProjectDataList] Cache invalid or missing, fetching fresh project list from Firebase.");
  try {
    const snapshot = await database.ref('projects').once('value');
    const projects = snapshot.val();
    let projectNames = [];
    if (projects) {
      projectNames = Object.values(projects)
                         .map(proj => proj?.info?.siteName)
                         .filter(name => name); // Extract names and filter out falsy values
    }
    const uniqueProjectNames = [...new Set(projectNames)]; // Ensure uniqueness
    
    // Store fresh unique data in cache
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data: uniqueProjectNames }));
      console.log("[populateProjectDataList] Fetched and cached unique project list.");
    } catch (e) {
      console.error("Error saving project list cache:", e);
    }
    return uniqueProjectNames; // Return freshly fetched unique data
  } catch (error) {
    console.error("Error fetching project list from Firebase:", error);
    alert("現場リストの読み込みに失敗しました。");
    return []; // Return empty list on error
  }
}

// ======================================================================
// 10. Data Manipulation - Deterioration Counter
// ======================================================================
async function getNextDeteriorationNumber(projectId, buildingId) {
  if (!projectId || !buildingId) {
      console.warn("[getNextDeteriorationNumber] Missing projectId or buildingId.");
      return 1; // Default to 1 if IDs are missing
  }
  const counterRef = getDeteriorationCounterRef(projectId, buildingId);
  let nextNumber = 1;
  try {
      const result = await counterRef.transaction(currentCounter => {
          // If the counter doesn't exist, initialize it to 1.
          // Otherwise, increment it.
          return (currentCounter || 0) + 1;
      });

      if (result.committed && result.snapshot.exists()) {
          nextNumber = result.snapshot.val();
          console.log(`[getNextDeteriorationNumber] Successfully obtained next number: ${nextNumber} for ${projectId}/${buildingId}`);
      } else {
          console.warn("[getNextDeteriorationNumber] Transaction not committed or snapshot doesn't exist. Defaulting to 1.");
          // Attempt to read the value directly as a fallback, though less reliable
          const fallbackSnapshot = await counterRef.once('value');
          nextNumber = (fallbackSnapshot.val() || 0) + 1; 
      }
  } catch (error) {
      console.error("Error getting next deterioration number:", error);
      // Fallback: try to read the current value and increment, less safe
      try {
        const snapshot = await counterRef.once('value');
        nextNumber = (snapshot.val() || 0) + 1;
      } catch (readError) {
          console.error("Fallback read also failed:", readError);
          nextNumber = 1; // Ultimate fallback
      }
  }
  return nextNumber;
}

// ★ 追加: 写真番号を安全に採番する関数 (トランザクション使用)
async function getNextPhotoNumber(projectId, buildingId) {
    if (!projectId || !buildingId) {
        console.warn("[getNextPhotoNumber] Missing projectId or buildingId.");
        return 1; // デフォルト値 (適切な初期値を検討)
    }
    const counterRef = getPhotoCounterRef(projectId, buildingId);
    let nextPhotoNumber = 1;
    try {
        const result = await counterRef.transaction(currentCounter => {
            // カウンターが存在しない場合は1から開始、存在する場合はインクリメント
            return (currentCounter || 0) + 1;
        });

        if (result.committed && result.snapshot.exists()) {
            nextPhotoNumber = result.snapshot.val();
            console.log(`[getNextPhotoNumber] Successfully obtained next photo number: ${nextPhotoNumber} for ${projectId}/${buildingId}`);
        } else {
            console.warn("[getNextPhotoNumber] Transaction not committed or snapshot doesn't exist. Reading directly as fallback.");
            const fallbackSnapshot = await counterRef.once('value');
            nextPhotoNumber = (fallbackSnapshot.val() || 0) + 1;
        }
    } catch (error) {
        console.error("[getNextPhotoNumber] Error in transaction:", error);
        // フォールバック: 現在の値を読み取ってインクリメント (競合の可能性あり)
        try {
            const snapshot = await counterRef.once('value');
            nextPhotoNumber = (snapshot.val() || 0) + 1;
        } catch (readError) {
            console.error("[getNextPhotoNumber] Fallback read also failed:", readError);
            nextPhotoNumber = 1; // 最終フォールバック
        }
    }
    return nextPhotoNumber;
}

// ======================================================================
// 14. Event Listener Setup - Selection Changes (Site/Building) (Modified)
// ======================================================================
function setupSelectionListeners(siteNameInput, projectDataListElement, buildingSelectElement, activeProjectNameSpanElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {

  // --- Site Name Input Listener ---  
  const updateAndDisplayDataList = async () => {
      const projectNames = await populateProjectDataList(projectDataListElement); // Fetch or get from cache
      updateDatalistWithOptions(projectNames, projectDataListElement); // Update datalist UI
  };

  // Update datalist when the input gets focus
  siteNameInput.addEventListener('focus', updateAndDisplayDataList);

  siteNameInput.addEventListener('change', async () => {
    const selectedSiteName = siteNameInput.value.trim();
    const projectId = generateProjectId(selectedSiteName);
    console.log(`[Site Name Change] Selected site: ${selectedSiteName}, Generated ID: ${projectId}`);

    if (!projectId) {
      // Handle case where input is cleared or invalid
      console.log("[Site Name Change] No project ID generated, resetting UI.");
      currentProjectId = null;
      currentBuildingId = null;
      buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
      buildingSelectElement.disabled = true;
      activeProjectNameSpanElement.textContent = '未選択';
      activeBuildingNameSpanElement.textContent = '未選択';
      localStorage.removeItem('lastProjectId');
      localStorage.removeItem('lastBuildingId');
      updateNextIdDisplay(null, null, nextIdDisplayElement);
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
      return;
    }

    // Check if the entered project actually exists in Firebase
    const projectInfoRef = getProjectInfoRef(projectId);
    const snapshot = await projectInfoRef.once('value');
    if (snapshot.exists() && snapshot.val().siteName === selectedSiteName) {
      // Project exists, update state and UI
      console.log("[Site Name Change] Project exists. Updating UI and loading buildings.");
      currentProjectId = projectId;
      activeProjectNameSpanElement.textContent = selectedSiteName;
      localStorage.setItem('lastProjectId', currentProjectId);
      
      // Add to recent list and update datalist order
      addProjectToRecentList(selectedSiteName);
      await updateAndDisplayDataList(); // Use await here to ensure datalist is updated before proceeding
      
      // Load other related data
      await loadBasicInfo(currentProjectId, siteNameInput);
      await updateBuildingSelectorForProject(currentProjectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    } else {
      // Project does not exist or name mismatch
      console.log("[Site Name Change] Entered project name does not exist in database. Resetting related fields.");
      currentProjectId = null;
      currentBuildingId = null;
      buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
      buildingSelectElement.disabled = true;
      activeProjectNameSpanElement.textContent = '未選択';
      activeBuildingNameSpanElement.textContent = '未選択';
      localStorage.removeItem('lastProjectId');
      localStorage.removeItem('lastBuildingId');
      updateNextIdDisplay(null, null, nextIdDisplayElement);
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
    }
  });

  // --- Building Select Listener --- (No changes needed here for this feature)
  buildingSelectElement.addEventListener('change', () => handleBuildingSelectChange(buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput));
}

// ======================================================================
// 20. Basic Info Saving (Separate Function)
// ======================================================================
function saveBasicInfo(siteNameInput) {
  const siteName = siteNameInput.value.trim();
  const projectId = generateProjectId(siteName);

  if (projectId) { 
    const infoRef = getProjectInfoRef(projectId);
    infoRef.once('value').then(snapshot => {
      if (snapshot.exists()) {
        const currentSiteName = snapshot.val().siteName;
        if (siteName && siteName !== currentSiteName) {
             infoRef.update({ siteName: siteName })
             .then(() => console.log(`[saveBasicInfo] Site name updated for ${projectId}`))
             .catch(error => console.error("Error updating site name:", error));
        }
      } else {
          console.log(`[saveBasicInfo] Project info for ${projectId} does not exist. No data saved.`);
      }
    }).catch(error => {
        console.error("Error checking project info before saving:", error);
    });

  }
}

// ★ 再追加: setupBasicInfoListeners 関数
function setupBasicInfoListeners(siteNameInput) {
    const saveSiteNameHandler = () => saveBasicInfo(siteNameInput);
    // Save on blur (when focus leaves the input)
    siteNameInput.addEventListener('blur', saveSiteNameHandler);
    console.log("[setupBasicInfoListeners] Listener for siteNameInput attached.");
}

// ======================================================================
// 18. Initialization (Modified)
// ======================================================================
async function initializeApp() {
  console.log("Initializing app...");

  // DOM Element References (Ensure all needed elements are here)
  const infoTabBtn = document.getElementById('infoTabBtn');
  const detailTabBtn = document.getElementById('detailTabBtn');
  const infoTab = document.getElementById('infoTab');
  const detailTab = document.getElementById('detailTab');
  const siteNameInput = document.getElementById('siteName');
  const projectDataListElement = document.getElementById('projectDataList'); 
  const addBuildingBtn = document.getElementById('addBuildingBtn');
  const buildingSelectElement = document.getElementById('buildingSelect');
  const activeProjectNameSpanElement = document.getElementById('activeProjectName');
  const activeBuildingNameSpanElement = document.getElementById('activeBuildingName');
  const deteriorationForm = document.getElementById('deteriorationForm');
  const locationInput = document.getElementById('locationInput');
  const locationPredictionsElement = document.getElementById('locationPredictions');
  const deteriorationNameInput = document.getElementById('deteriorationNameInput');
  const suggestionsElement = document.getElementById('suggestions');
  const photoNumberInput = document.getElementById('photoNumberInput');
  const nextIdDisplayElement = document.getElementById('nextIdDisplay');
  const submitDeteriorationBtn = document.getElementById('submitDeteriorationBtn');
  const continuousAddBtn = document.getElementById('continuousAddBtn');
  const deteriorationTableBodyElement = document.getElementById('deteriorationTableBody');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const currentYearSpan = document.getElementById('currentYear');
  const editModalElement = document.getElementById('editModal');
  const editForm = document.getElementById('editForm');
  const editIdDisplay = document.getElementById('editIdDisplay');
  const editLocationInput = document.getElementById('editLocationInput');
  const editLocationPredictionsElement = document.getElementById('editLocationPredictions');
  const editDeteriorationNameInput = document.getElementById('editDeteriorationNameInput');
  const editSuggestionsElement = document.getElementById('editSuggestions');
  const editPhotoNumberInput = document.getElementById('editPhotoNumberInput');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const buildingCheckboxContainer = document.getElementById('buildingCheckboxContainer'); 

  // Load prediction data (CSV files)
  await loadPredictionData();

  // --- Event Listeners Setup ---
  // Tab switching
  infoTabBtn.addEventListener('click', () => switchTab('info', infoTabBtn, detailTabBtn, infoTab, detailTab));
  detailTabBtn.addEventListener('click', () => {
    switchTab('detail', infoTabBtn, detailTabBtn, infoTab, detailTab);
  });

  // Basic Info saving (site name only)
  setupBasicInfoListeners(siteNameInput);

  // Add Project/Building 
  // ★ 修正: リスナー重複登録を防ぐため、一度リスナーを削除してから再登録する
  const addBuildingHandler = () => handleAddProjectAndBuilding(
    siteNameInput, 
    buildingCheckboxContainer, // ★ 修正: チェックボックスコンテナを渡す
    projectDataListElement, 
    buildingSelectElement, 
    activeProjectNameSpanElement, 
    activeBuildingNameSpanElement, 
    nextIdDisplayElement, 
    deteriorationTableBodyElement, 
    editModalElement, 
    editIdDisplay, 
    editLocationInput, 
    editDeteriorationNameInput, 
    editPhotoNumberInput,
    infoTabBtn, 
    detailTabBtn, 
    infoTab, 
    detailTab
  );
  // 既存のリスナーがあれば削除
  addBuildingBtn.removeEventListener('click', addBuildingHandler);
  // 新しいリスナーを登録
  addBuildingBtn.addEventListener('click', addBuildingHandler);
  console.log("[Init] addBuildingBtn listener attached (or re-attached)."); // ★ ログ追加

  // Site/Building Selection
  // ★ 修正: setupSelectionListeners から buildingSelectPresetElement を削除
  setupSelectionListeners(
      siteNameInput, 
      projectDataListElement, 
      buildingSelectElement, 
      activeProjectNameSpanElement, 
      activeBuildingNameSpanElement, 
      nextIdDisplayElement, 
      deteriorationTableBodyElement, 
      editModalElement, 
      editIdDisplay, 
      editLocationInput, 
      editDeteriorationNameInput, 
      editPhotoNumberInput
  );

  // Deterioration Form Submission
  deteriorationForm.addEventListener('submit', (event) => handleDeteriorationSubmit(event, locationInput, deteriorationNameInput, photoNumberInput, nextIdDisplayElement, locationPredictionsElement));
  // ★ 修正: handleContinuousAdd の呼び出し引数を変更
  continuousAddBtn.addEventListener('click', () => handleContinuousAdd(nextIdDisplayElement, locationInput)); 

  // Input Predictions (Deterioration Form)
  setupPredictionListeners(locationInput, locationPredictionsElement, generateLocationPredictions, 'deteriorationNameInput');
  setupPredictionListeners(deteriorationNameInput, suggestionsElement, generateDegradationPredictions, 'photoNumberInput');

  // Edit Modal Handling
  editForm.addEventListener('submit', (event) => handleEditSubmit(event, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, editModalElement));
  cancelEditBtn.addEventListener('click', () => editModalElement.classList.add('hidden'));
  setupPredictionListeners(editLocationInput, editLocationPredictionsElement, generateLocationPredictions, 'editDeteriorationNameInput');
  setupPredictionListeners(editDeteriorationNameInput, editSuggestionsElement, generateDegradationPredictions, 'editPhotoNumberInput');

  // CSV Export
  exportCsvBtn.addEventListener('click', () => handleExportCsv(siteNameInput, buildingSelectElement));

  // Footer Year
  currentYearSpan.textContent = new Date().getFullYear();

  // --- Initial State Loading ---
  let initialTab = 'info'; // デフォルトタブ

  // Fetch initial project list and populate datalist
  const initialProjectNames = await populateProjectDataList(projectDataListElement);
  updateDatalistWithOptions(initialProjectNames, projectDataListElement);

  // Try to restore last project and building
  const lastProjectId = localStorage.getItem('lastProjectId');
  const lastBuildingId = localStorage.getItem('lastBuildingId');
  let projectRestored = false;
  let buildingRestored = false;

  if (lastProjectId) {
    console.log(`[Init] Attempting to restore project ID: ${lastProjectId}`);
    // Validate project exists and get its name
    const projectInfoRef = getProjectInfoRef(lastProjectId);
    const infoSnapshot = await projectInfoRef.once('value');
    if (infoSnapshot.exists()) {
      currentProjectId = lastProjectId; // Set currentProjectId only if valid
      const restoredSiteName = infoSnapshot.val().siteName || '不明な現場';
      siteNameInput.value = restoredSiteName; // Set input value as well
      activeProjectNameSpanElement.textContent = restoredSiteName;
      addProjectToRecentList(restoredSiteName);
      updateDatalistWithOptions(initialProjectNames, projectDataListElement); // Update list with recent item potentially moved up
      projectRestored = true;
      console.log(`[Init] Project ${currentProjectId} (${restoredSiteName}) restored.`);

      // Now attempt to load buildings for the restored project
      // Pass lastBuildingId as a hint to updateBuildingSelectorForProject
      lastUsedBuilding = lastBuildingId; 
      await updateBuildingSelectorForProject(currentProjectId, buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
      // updateBuildingSelectorForProject should set currentBuildingId if successful

      // Check if the building was actually restored successfully
      if (currentBuildingId === lastBuildingId && currentBuildingId !== null) {
          buildingRestored = true;
          console.log(`[Init] Building ${currentBuildingId} restored successfully for project ${currentProjectId}.`);
          // Deterioration data is fetched within updateBuildingSelectorForProject or its subsequent calls
      } else {
         console.log(`[Init] Failed to restore building ID ${lastBuildingId} (current is ${currentBuildingId}). Building not fully restored.`);
         // Keep buildingRestored = false
      }
    } else {
      console.warn(`[Init] Last project ID ${lastProjectId} not found in database. Clearing stored IDs.`);
      localStorage.removeItem('lastProjectId');
      localStorage.removeItem('lastBuildingId');
      // Keep projectRestored = false
    }
  }

  // If no project was restored, set default UI state
  if (!projectRestored) {
    console.log("[Init] No project restored. Setting default UI state.");
    siteNameInput.value = ''; 
    activeProjectNameSpanElement.textContent = '未選択';
    activeBuildingNameSpanElement.textContent = '未選択';
    buildingSelectElement.innerHTML = '<option value="">-- 現場を先に選択 --</option>';
    buildingSelectElement.disabled = true;
    updateNextIdDisplay(null, null, nextIdDisplayElement); 
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
  }

  // Determine initial tab based on restored state AND localStorage
  const lastActiveTabId = localStorage.getItem('lastActiveTabId');
  if (lastActiveTabId === 'detail' && projectRestored && buildingRestored) {
    initialTab = 'detail';
    console.log("[Init] Conditions met. Restoring to detail tab.");
  } else {
    initialTab = 'info'; // Default to info if conditions not met
    console.log(`[Init] Setting initial tab to info (Reason: LastTab='${lastActiveTabId}', ProjectRestored=${projectRestored}, BuildingRestored=${buildingRestored})`);
  }

  // Finally, switch to the determined initial tab
  switchTab(initialTab, infoTabBtn, detailTabBtn, infoTab, detailTab);

  // ★ 追加: 写真番号入力欄に半角数字強制リスナーを設定
  enforceHalfWidthDigits(photoNumberInput);
  enforceHalfWidthDigits(editPhotoNumberInput);

  console.log("App initialized.");
}

// Run initialization when the DOM is ready
document.addEventListener('DOMContentLoaded', initializeApp);

// ======================================================================
// 10. Event Handler - Add Project/Building (Refactored)
// ======================================================================
// --- Helper function to ensure project exists ---
async function ensureProjectExists(projectId, siteName, projectDataListElement) {
  console.log(`[ensureProjectExists] Checking/Creating project info for ${projectId}...`);
  const projectInfoRef = getProjectInfoRef(projectId);
  const projectInfoSnapshot = await projectInfoRef.once('value');
  let projectInfoCreatedOrUpdated = false;

  if (!projectInfoSnapshot.exists()) {
    console.log(`[ensureProjectExists] Project info for ${projectId} does not exist. Creating...`);
    await projectInfoRef.set({
      siteName: siteName,
      createdAt: firebase.database.ServerValue.TIMESTAMP
    });
    projectInfoCreatedOrUpdated = true;
    console.log("[ensureProjectExists] Project info saved successfully.");
    // Datalist更新は非同期で実行
    populateProjectDataList(projectDataListElement).then(names => updateDatalistWithOptions(names, projectDataListElement));
  } else {
    const existingSiteName = projectInfoSnapshot.val().siteName;
    if (existingSiteName !== siteName) {
      console.log(`[ensureProjectExists] Updating existing project ${projectId} siteName from '${existingSiteName}' to '${siteName}'.`);
      await projectInfoRef.update({ siteName: siteName });
      projectInfoCreatedOrUpdated = true;
      // Datalist更新は非同期で実行
      populateProjectDataList(projectDataListElement).then(names => updateDatalistWithOptions(names, projectDataListElement));
    } else {
      console.log(`[ensureProjectExists] Project info for ${projectId} already exists and name is current.`);
    }
  }
  return projectInfoCreatedOrUpdated;
}

// --- Helper function to determine buildings to add ---
function determineBuildingsToAdd(buildingCheckboxContainer) {
  const buildingsToAdd = [
    { id: "site", name: "敷地" },
    { id: "buildingA", name: "A棟" }
  ];
  let lastCheckedBuildingId = "buildingA";
  const allBuildingTypeOrder = ["site", "buildingA", "buildingB", "buildingC", "buildingD", "buildingE", "buildingF", "buildingG", "buildingH", "buildingI"];

  const checkedOtherBuildingCheckboxes = buildingCheckboxContainer.querySelectorAll('input[name="buildingToAdd"]:checked:not(:disabled)');
  checkedOtherBuildingCheckboxes.forEach(checkbox => {
    const buildingId = checkbox.value;
    if (!buildingsToAdd.some(b => b.id === buildingId)) {
      const label = buildingCheckboxContainer.querySelector(`label[for="${checkbox.id}"]`);
      const buildingName = label ? label.textContent.trim() : buildingId;
      buildingsToAdd.push({ id: buildingId, name: buildingName });
    }
  });

  buildingsToAdd.sort((a, b) => allBuildingTypeOrder.indexOf(a.id) - allBuildingTypeOrder.indexOf(b.id));

  if (buildingsToAdd.length > 0) { // Should always be true because of mandatory buildings
    lastCheckedBuildingId = buildingsToAdd[buildingsToAdd.length - 1].id;
  }

  console.log(`[determineBuildingsToAdd] Buildings determined:`, buildingsToAdd.map(b => b.id), `Last checked: ${lastCheckedBuildingId}`);
  return { buildingsToAdd, lastCheckedBuildingId };
}

// --- Helper function to save buildings to Firebase ---
async function saveBuildingsToFirebase(projectId, buildingsToAdd) {
  console.log(`[saveBuildingsToFirebase] Starting Firebase save for ${buildingsToAdd.length} buildings in project ${projectId}...`);
  const buildingAddPromises = buildingsToAdd.map(async (building) => {
    const buildingRef = getBuildingsRef(projectId).child(building.id);
    const buildingSnapshot = await buildingRef.once('value');
    if (!buildingSnapshot.exists()) {
      await buildingRef.set({
        name: building.name,
        createdAt: firebase.database.ServerValue.TIMESTAMP
      });
      console.log(`[saveBuildingsToFirebase] Building ${building.id} saved.`);
      return true; // New
    } else {
      const existingBuildingName = buildingSnapshot.val().name;
      if (existingBuildingName !== building.name) {
        console.log(`[saveBuildingsToFirebase] Updating existing building ${building.id} name from '${existingBuildingName}' to '${building.name}'.`);
        await buildingRef.update({ name: building.name });
        return true; // Updated
      }
      console.log(`[saveBuildingsToFirebase] Building ${building.id} already exists and name is current.`);
      return false; // No change
    }
  });

  const results = await Promise.all(buildingAddPromises);
  const wasAnyBuildingAddedOrUpdated = results.some(changed => changed === true);
  console.log(`[saveBuildingsToFirebase] Promise.all completed. wasAnyBuildingAddedOrUpdated: ${wasAnyBuildingAddedOrUpdated}`);
  return wasAnyBuildingAddedOrUpdated;
}

// 10. Event Handler - Add Project/Building (Refactored)
// ======================================================================
async function handleAddProjectAndBuilding(siteNameInput, buildingCheckboxContainer, projectDataListElement, buildingSelectElement, activeProjectNameSpanElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, infoTabBtn, detailTabBtn, infoTab, detailTab) {
  console.log("--- Add Building Start (Refactored) ---");
  const siteName = siteNameInput.value.trim();
  const checkedBuildingCheckboxes = buildingCheckboxContainer.querySelectorAll('input[name="buildingToAdd"]:checked');

  // --- 1. Input Validation ---
  if (!siteName) {
    alert("現場名を入力してください。");
    return;
  }
  if (checkedBuildingCheckboxes.length === 0) {
    alert("追加する建物を1つ以上選択してください。");
    return;
  }

  const projectId = generateProjectId(siteName);
  if (!projectId) {
    alert("現場名が無効です。");
    return;
  }
  console.log(`[handleAddProjectAndBuilding] Generated Project ID: ${projectId}`);

  try {
    // --- 2. Ensure Project Exists ---
    const projectInfoCreatedOrUpdated = await ensureProjectExists(projectId, siteName, projectDataListElement);

    // --- 3. Determine Buildings to Add ---
    const { buildingsToAdd, lastCheckedBuildingId } = determineBuildingsToAdd(buildingCheckboxContainer);

    // --- 4. Save Buildings ---
    let wasAnyBuildingAddedOrUpdated = false;
    if (buildingsToAdd.length > 0) {
        try {
            wasAnyBuildingAddedOrUpdated = await saveBuildingsToFirebase(projectId, buildingsToAdd);
        } catch (saveError) {
            console.error("[handleAddProjectAndBuilding] <<<< ERROR during saveBuildingsToFirebase >>>>:", saveError);
            alert(`建物の保存中にエラーが発生しました: ${saveError.message}`);
            return; // Stop processing on save error
        }
    } else {
        console.warn("[handleAddProjectAndBuilding] No buildings determined to be added.");
        // Optionally, handle this case, maybe alert the user or proceed differently
    }


    // --- 5. Update UI & Global State ---
    console.log(`[handleAddProjectAndBuilding] Preparing to update UI. Project: ${projectId}, Building to select: ${lastCheckedBuildingId}`);
    await updateBuildingSelectorForProject(projectId, buildingSelectElement, activeProjectNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, lastCheckedBuildingId);

    // Update global state only after all operations potentially using it are done
    currentProjectId = projectId;
    // currentBuildingId is updated within updateBuildingSelectorForProject now based on selection logic
    // We'll rely on updateBuildingSelectorForProject to set currentBuildingId and lastUsedBuilding correctly.
    localStorage.setItem('lastProjectId', currentProjectId);
    // localStorage.setItem('lastBuildingId', currentBuildingId); // updateBuildingSelector handles this


    console.log(`[handleAddProjectAndBuilding] State updated: currentProjectId=${currentProjectId}`); // Log currentProjectId, currentBuildingId might be async updated

    // Update UI elements
    activeProjectNameSpanElement.textContent = siteName;
    buildingSelectElement.disabled = false;
    buildingCheckboxContainer.querySelectorAll('input[name="buildingToAdd"]:not(:disabled)').forEach(checkbox => checkbox.checked = false);
    document.getElementById('addBuilding-site').checked = true; // Keep mandatory checked
    document.getElementById('addBuilding-A').checked = true;

    // --- 6. Switch Tab ---
    if (wasAnyBuildingAddedOrUpdated || projectInfoCreatedOrUpdated) {
      console.log('[handleAddProjectAndBuilding] Switching to detail tab due to changes.');
      switchTab('detail', infoTabBtn, detailTabBtn, infoTab, detailTab);
    } else {
      console.log('[handleAddProjectAndBuilding] No changes made, switching to detail tab anyway.');
      switchTab('detail', infoTabBtn, detailTabBtn, infoTab, detailTab); 
    }
    console.log("--- Add Building End (Success - Refactored) ---");

  } catch (error) {
    console.error("[handleAddProjectAndBuilding] <<<< UNEXPECTED FUNCTION ERROR (Refactored) >>>> :", error);
    alert(`処理中に予期せぬエラーが発生しました: ${error.message}`);
    console.log("--- Add Building End (Error - Refactored) ---");
  }
}

// ★ 再追加: handleBuildingSelectChange 関数
async function handleBuildingSelectChange(buildingSelectElement, activeBuildingNameSpanElement, nextIdDisplayElement, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
  const selectedBuildingId = buildingSelectElement.value;
  console.log(`[Building Select Change] Selected Building ID: ${selectedBuildingId}`);
  if (!currentProjectId || !selectedBuildingId) {
    console.log("[Building Select Change] No current project or selected building ID.");
    activeBuildingNameSpanElement.textContent = '未選択';
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput); // Clear table
    updateNextIdDisplay(currentProjectId, null, nextIdDisplayElement); // Clear next ID display
    return;
  }

  currentBuildingId = selectedBuildingId;
  lastUsedBuilding = currentBuildingId;
  localStorage.setItem('lastBuildingId', currentBuildingId);

  // Update active building name display
  activeBuildingNameSpanElement.textContent = buildingSelectElement.options[buildingSelectElement.selectedIndex]?.text || '不明';

  // Fetch and render deteriorations for the selected building
  await fetchAndRenderDeteriorations(currentProjectId, currentBuildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
}

// ★ 再追加: recordLastAddedData 関数 (連続登録用 - 写真番号も記憶)
function recordLastAddedData(location, name, photoNumber) {
    lastAddedLocation = location;
    lastAddedName = name;
    lastAddedPhotoNumber = photoNumber; // ★ 追加
    console.log(`[recordLastAddedData] Recorded last added: Location="${lastAddedLocation}", Name="${lastAddedName}", Photo="${lastAddedPhotoNumber}"`);
}

// ======================================================================
// 11. Event Handlers - Deterioration Form
// ======================================================================

// ★ 再追加: handleDeteriorationSubmit 関数 (引数に locationPredictionsElement を追加)
// ★ async に変更
async function handleDeteriorationSubmit(event, locationInput, deteriorationNameInput, photoNumberInput, nextIdDisplayElement, locationPredictionsElement) { 
  event.preventDefault();
  const location = locationInput.value.trim();
  const deteriorationName = deteriorationNameInput.value.trim();
  const photoNumberInputStr = photoNumberInput.value.trim(); // ★ 変数名変更
  
  if (!/^[0-9]*$/.test(photoNumberInputStr)) {
    alert("写真番号は半角数字のみで入力してください。");
    return; 
  }

  if (!location || !deteriorationName || !photoNumberInputStr) {
    alert("すべてのフィールドを入力してください。");
    return;
  }

  if (!currentProjectId || !currentBuildingId) {
    alert("現場名または建物名が選択されていません。");
    return;
  }

  console.log(`[handleDeteriorationSubmit] Submitting new deterioration for project ID: ${currentProjectId}, building ID: ${currentBuildingId}`);

  try { // ★ try-catch ブロックを追加
    // ★ 変更: 劣化番号と写真番号カウンター更新を並行して処理
    const [nextNumber, photoNumberToUse] = await Promise.all([
        getNextDeteriorationNumber(currentProjectId, currentBuildingId),
        updatePhotoCounterIfNeeded(currentProjectId, currentBuildingId, photoNumberInputStr)
    ]);

    // ★ photoNumberToUse を使用 (updatePhotoCounterIfNeeded は現状ユーザー入力をそのまま返す設計)
    const deteriorationData = {
      number: nextNumber, 
      location: location,
      name: deteriorationName,
      photoNumber: photoNumberToUse, // ★ 決定された写真番号を使用
      createdAt: firebase.database.ServerValue.TIMESTAMP
    };

    const deteriorationRef = getDeteriorationsRef(currentProjectId, currentBuildingId);
    await deteriorationRef.push(deteriorationData); // ★ await に変更

    console.log("[handleDeteriorationSubmit] New deterioration submitted successfully.");
    hidePredictions(locationPredictionsElement); 
    locationInput.value = '';
    deteriorationNameInput.value = '';
    photoNumberInput.value = '';
    updateNextIdDisplay(currentProjectId, currentBuildingId, nextIdDisplayElement);
    recordLastAddedData(location, deteriorationName, photoNumberToUse); // ★ 決定された写真番号を記録
    locationInput.focus();

  } catch (error) { // ★ catch ブロック
      console.error("[handleDeteriorationSubmit] Error:", error);
      alert("情報の保存中にエラーが発生しました: " + error.message);
  }
}

// ★ 修正: handleContinuousAdd 関数 (写真番号を自動インクリメント)
async function handleContinuousAdd(nextIdDisplayElement, locationInput) { // 引数変更
  // ★ 削除: photoNumberInput からの値取得・チェックを削除
  // const photoNumber = photoNumberInput.value.trim();
  // if (!photoNumber) {
  //   alert("写真番号を入力してください。");
  //   return;
  // }

  // 直前の場所・劣化名を取得 (写真番号は使わない)
  const location = lastAddedLocation;
  const deteriorationName = lastAddedName;
  // const previousPhotoNumber = lastAddedPhotoNumber; // ★ 不要

  // 必要な情報が揃っているかチェック
  if (!currentProjectId || !currentBuildingId) {
    alert("現場と建物が選択されていません。基本情報タブで選択してください。");
    return;
  }
  if (!location || !deteriorationName) {
    alert("直前に登録された場所・劣化名がありません。一度通常登録を行ってください。");
    return;
  }
  // ★ previousPhotoNumber のチェックは不要になったため削除
  // if (previousPhotoNumber === '' || isNaN(parseInt(previousPhotoNumber))) {
  //   alert("直前に登録された有効な写真番号がありません。一度通常登録を行ってください。");
  //   return;
  // }

  // ★ 変更: Firebaseトランザクションで写真番号を安全に取得
  let newPhotoNumber;
  try {
    newPhotoNumber = await getNextPhotoNumber(currentProjectId, currentBuildingId);
  } catch (error) {
      alert("次の写真番号の取得中にエラーが発生しました: " + error.message);
      return;
  }
  
  // const newPhotoNumber = parseInt(previousPhotoNumber) + 1; // ★ 削除: 古い採番ロジック

  console.log(`[handleContinuousAdd] Submitting continuous addition for project ID: ${currentProjectId}, building ID: ${currentBuildingId} using last data: Loc='${location}', Name='${deteriorationName}', NewPhoto='${newPhotoNumber}'`);

  try {
    // 次の劣化番号を取得
    const nextNumber = await getNextDeteriorationNumber(currentProjectId, currentBuildingId);
    
    const deteriorationData = {
      number: nextNumber, 
      location: location, 
      name: deteriorationName, 
      photoNumber: newPhotoNumber.toString(), // ★ トランザクションで取得した写真番号
      createdAt: firebase.database.ServerValue.TIMESTAMP
    };

    const deteriorationRef = getDeteriorationsRef(currentProjectId, currentBuildingId);
    await deteriorationRef.push(deteriorationData);

    console.log("[handleContinuousAdd] New continuous addition submitted successfully.");
    // ★ 削除: 不要なフォームクリア処理
    // photoNumberInput.value = ''; 
    updateNextIdDisplay(currentProjectId, currentBuildingId, nextIdDisplayElement);
    // ★ 記録: 連続登録でも最後に登録した情報を更新する (実際に保存された番号を使う)
    recordLastAddedData(location, deteriorationName, newPhotoNumber.toString()); 
    // ★ 変更: 場所入力にフォーカスを戻す
    locationInput.focus(); 

  } catch (error) {
    console.error("[handleContinuousAdd] Error:", error);
    // エラーの種類に応じてメッセージを分けることも検討
    if (error.message.includes("getNextDeteriorationNumber")) {
         alert("次の劣化番号の取得中にエラーが発生しました: " + error.message);
    } else {
         alert("情報の保存中にエラーが発生しました: " + error.message);
    }
  }
}

// ★ 再追加: handleEditClick 関数
// ★ 修正: 編集対象データをFirebaseから取得して表示するように変更
async function handleEditClick(projectId, buildingId, recordId, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
  console.log(`[handleEditClick] Editing record with ID: ${recordId} in project ID: ${projectId}, building ID: ${buildingId}`);
  currentEditRecordId = recordId; // Keep track of the actual Firebase record ID

  // Firebaseから編集対象のデータを取得
  const recordRef = getDeteriorationsRef(projectId, buildingId).child(recordId);
  try {
    const snapshot = await recordRef.once('value');
    const recordData = snapshot.val();

    if (recordData) {
      // データをモーダルに設定
      editIdDisplay.textContent = recordData.number || ''; // ★ 修正: recordData.number を表示
      editLocationInput.value = recordData.location || '';
      editDeteriorationNameInput.value = recordData.name || '';
      editPhotoNumberInput.value = recordData.photoNumber || '';

      // モーダルを表示
      editModalElement.classList.remove('hidden');
    } else {
      console.error(`[handleEditClick] Record data not found for ID: ${recordId}`);
      alert("編集対象のデータが見つかりませんでした。");
    }
  } catch (error) {
    console.error("[handleEditClick] Error fetching record data:", error);
    alert("編集データの取得中にエラーが発生しました: " + error.message);
  }
}

// ★ 再追加: handleDeleteClick 関数
function handleDeleteClick(projectId, buildingId, recordId, recordNumber) {
  console.log(`[handleDeleteClick] Deleting record with ID: ${recordId} in project ID: ${projectId}, building ID: ${buildingId}`);
  const confirmation = confirm(`レコード ${recordNumber} を削除してもよろしいですか？`);
  if (confirmation) {
    const deteriorationRef = getDeteriorationsRef(projectId, buildingId).child(recordId);
    deteriorationRef.remove()
      .then(() => {
        console.log(`[handleDeleteClick] Record ${recordId} deleted successfully.`);
        hidePredictions(locationPredictionsElement);
        locationInput.value = '';
        deteriorationNameInput.value = '';
        photoNumberInput.value = '';
        updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement);
      })
      .catch(error => {
        console.error("[handleDeleteClick] Error deleting record:", error);
        alert("レコードの削除中にエラーが発生しました: " + error.message);
      });
  }
}

// ★ 再追加: handleEditSubmit 関数
function handleEditSubmit(event, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput, editModalElement) {
  event.preventDefault();
  // ★ 修正: recordId は currentEditRecordId から取得 (表示されているのは number のため)
  const recordId = currentEditRecordId;
  const location = editLocationInput.value.trim();
  const deteriorationName = editDeteriorationNameInput.value.trim();
  const photoNumber = editPhotoNumberInput.value.trim();

  // ★ 追加: 写真番号の送信時バリデーション
  if (!/^[0-9]*$/.test(photoNumber)) {
    alert("写真番号は半角数字のみで入力してください。");
    return; // 処理を中断
  }

  if (!recordId) {
    alert("編集対象のレコードIDが見つかりません。");
    return;
  }

  if (!location || !deteriorationName || !photoNumber) {
    alert("すべてのフィールドを入力してください。");
    return;
  }

  // ★ 修正: projectId と buildingId は現在のものを利用
  const projectId = currentProjectId;
  const buildingId = currentBuildingId;

  if (!projectId || !buildingId) {
    alert("現在の現場名または建物名が不明です。"); // より具体的なエラーメッセージ
    return;
  }

  console.log(`[handleEditSubmit] Submitting edited record with ID: ${recordId} in project ID: ${projectId}, building ID: ${buildingId}`);

  // ★ 注意: createdAt は更新しないのが一般的。更新日時が必要なら updatedAt を追加する
  const deteriorationUpdateData = {
    location: location,
    name: deteriorationName,
    photoNumber: photoNumber,
    // createdAt: firebase.database.ServerValue.TIMESTAMP // 通常、作成日時は更新しない
    lastUpdatedAt: firebase.database.ServerValue.TIMESTAMP // 更新日時を追加する場合
  };

  const deteriorationRef = getDeteriorationsRef(projectId, buildingId).child(recordId);
  deteriorationRef.update(deteriorationUpdateData)
    .then(() => {
      console.log("[handleEditSubmit] Edited record updated successfully.");
      // ★ 削除: hidePredictions の呼び出しを削除
      // hidePredictions(locationPredictionsElement);
      editModalElement.classList.add('hidden');
      // ★ 削除: メインフォームのクリア処理は不要
      // locationInput.value = '';
      // deteriorationNameInput.value = '';
      // photoNumberInput.value = '';
      // ★ 削除: updateNextIdDisplay の呼び出しは不要（編集ではカウンターは変わらない）
      // updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement);
    })
    .catch(error => {
      console.error("[handleEditSubmit] Error updating edited record:", error);
      alert("情報の保存中にエラーが発生しました: " + error.message);
    });
}

// ★ 再追加: handleExportCsv 関数
function handleExportCsv(siteNameInput, buildingSelectElement) {
  const siteName = siteNameInput.value.trim();
  const buildingName = buildingSelectElement.value;

  if (!siteName || !buildingName) {
    alert("すべてのフィールドを入力してください。");
    return;
  }

  const projectId = generateProjectId(siteName);
  const buildingId = generateBuildingId(buildingName);

  if (!projectId || !buildingId) {
    alert("現場名または建物名が無効です。");
    return;
  }

  console.log(`[handleExportCsv] Exporting CSV for project ID: ${projectId}, building ID: ${buildingId}`);

  // Fetch deteriorations for the selected project and building
  const deteriorationRef = getDeteriorationsRef(projectId, buildingId);
  // ★ Fetch data using once() instead of on() for export
  deteriorationRef.once('value', (snapshot) => {
    const data = snapshot.val();
    let deteriorations = [];
    if (data) {
      deteriorations = Object.entries(data).map(([id, deterioration]) => ({
        id,
        ...deterioration
      }));
    } else {
        console.log("[handleExportCsv] No data found to export.");
        alert("エクスポートするデータがありません。");
        return; // Exit if no data
    }

    // ★ Define CSV Header
    const csvHeader = ['番号', '場所', '劣化名', '写真番号', '登録日']; // ★ 追加: 番号

    // ★ Convert deteriorations to CSV format including formatted createdAt
    const csvRows = deteriorations.map(deterioration => {
        // Format timestamp (handle potential undefined createdAt)
        let formattedDate = '';
        if (deterioration.createdAt) {
            const date = new Date(deterioration.createdAt);
            // Pad single digit month/day/hour/minute/second with zero
            const pad = (num) => num.toString().padStart(2, '0');
            formattedDate = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        }

        // Escape comma, double quotes, and newline within fields
        const escapeCsvField = (field) => {
            const stringField = String(field == null ? '' : field); // Handle null/undefined
            // If field contains comma, newline, or double quote, enclose in double quotes
            if (stringField.includes(',') || stringField.includes('\n') || stringField.includes('"')) {
                // Escape existing double quotes by doubling them
                return `"${stringField.replace(/"/g, '""')}"`;
            }
            return stringField;
        };

        return [
            escapeCsvField(deterioration.number), // ★ 修正: counter から number に変更
            escapeCsvField(deterioration.location),
            escapeCsvField(deterioration.name),
            escapeCsvField(deterioration.photoNumber),
            escapeCsvField(formattedDate) // Add formatted date
        ].join(','); // Join fields with comma
    });

    // ★ Combine header and rows
    const csvContent = [
        csvHeader.join(','), // Join header fields with comma
        ...csvRows
    ].join('\n'); // Join header and rows with newline

    // ★ Create a Blob with UTF-8 BOM and correct MIME type
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    // Create a temporary anchor element to trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectId}_${buildingId}_deteriorations.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);

    // Trigger download
    a.click();

    // Clean up
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
    console.log("[handleExportCsv] CSV export initiated.");

  }, (error) => {
    console.error("[handleExportCsv] Error fetching data for export:", error);
    alert("CSVエクスポート用データの取得中にエラーが発生しました: " + error.message);
  });
}

// ======================================================================
// 19. Listener Cleanup
// ======================================================================
function detachAllDeteriorationListeners() {
  console.log("[detachAllDeteriorationListeners] Detaching all listeners...");
  Object.entries(deteriorationListeners).forEach(([key, listener]) => {
    console.log(`[detachAllDeteriorationListeners] Detaching listener for ${key}`);
    listener.ref.off('value', listener.callback);
  });
  deteriorationListeners = {}; // Clear the listeners object
}

// ★ 追加: 通常登録時に写真カウンターを必要に応じて更新する関数
async function updatePhotoCounterIfNeeded(projectId, buildingId, userEnteredPhotoNumber) {
    if (!projectId || !buildingId) {
        console.warn("[updatePhotoCounterIfNeeded] Missing projectId or buildingId.");
        return userEnteredPhotoNumber; // カウンター更新不可、入力値をそのまま返す
    }
    const numericPhotoNumber = parseInt(userEnteredPhotoNumber);
    if (isNaN(numericPhotoNumber)) {
        console.warn("[updatePhotoCounterIfNeeded] Invalid userEnteredPhotoNumber:", userEnteredPhotoNumber);
        return userEnteredPhotoNumber; // 不正な入力値、そのまま返す
    }

    const counterRef = getPhotoCounterRef(projectId, buildingId);
    try {
        const result = await counterRef.transaction(currentCounter => {
            const currentNumericCounter = parseInt(currentCounter || 0); // 現在のカウンター値 (数値)
            // ユーザー入力値が現在のカウンターより大きい場合のみ、カウンターを更新
            if (numericPhotoNumber > currentNumericCounter) {
                return numericPhotoNumber; // カウンターをユーザー入力値で上書き
            }
            // そうでなければカウンターは変更しない (undefined を返すとトランザクションが中断される)
            return currentCounter; 
        });
        
        if (result.committed) {
             console.log(`[updatePhotoCounterIfNeeded] Photo counter transaction committed. Final counter: ${result.snapshot.val()}`);
        } else {
             console.warn("[updatePhotoCounterIfNeeded] Photo counter transaction aborted. Counter may not be updated.");
        }

    } catch (error) {
        console.error("[updatePhotoCounterIfNeeded] Error in transaction:", error);
        // エラーが発生した場合も、ユーザーが入力した値をそのまま使う
    }
    // どの道、通常登録ではユーザーが入力した値を優先して返す
    return userEnteredPhotoNumber;
}

// ======================================================================
// 15. Data Loading - Deterioration List (Modified)
// ======================================================================
// ★ 移動: setupDeteriorationListener 関数定義をここに移動
function setupDeteriorationListener(projectId, buildingId, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
  const listenerKey = `${projectId}_${buildingId}`;
  console.log(`[setupDeteriorationListener] Setting up listener for ${listenerKey}`); // ★ 追加ログ
  
  // Detach previous listener for this specific building if it exists
  if (deteriorationListeners[listenerKey]) {
    console.log(`[setupDeteriorationListener] Detaching existing listener for ${listenerKey}`);
    try {
        deteriorationListeners[listenerKey].ref.off('value', deteriorationListeners[listenerKey].callback);
    } catch (detachError) {
        console.warn(`[setupDeteriorationListener] Error detaching listener for ${listenerKey}:`, detachError);
    }
    delete deteriorationListeners[listenerKey];
  }

  const deteriorationRef = getDeteriorationsRef(projectId, buildingId);

  // Define the callback for the listener
  const listenerCallback = (snapshot) => {
    console.log(`[Deterioration Listener Callback] Data received for ${listenerKey}`); // ★ 追加ログ
    try { // ★ コールバック内に try...catch を追加
        const data = snapshot.val() || {};
        // console.log(`[Deterioration Listener Callback] Raw data for ${listenerKey}:`, data); // ★ 必要なら追加
        deteriorationData[buildingId] = data; // Update local cache
        const records = Object.entries(data).map(([id, deterioration]) => ({
          id,
          ...deterioration
        })).sort((a, b) => b.number - a.number); 
        console.log(`[Deterioration Listener Callback] Rendering ${records.length} records for ${listenerKey}`); // ★ 追加ログ
        renderDeteriorationTable(records, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
        console.log(`[Deterioration Listener Callback] Finished rendering for ${listenerKey}`); // ★ 追加ログ
    } catch (callbackError) {
        console.error(`[Deterioration Listener Callback] <<<< ERROR >>>> Error processing data or rendering table for ${listenerKey}:`, callbackError);
        // エラー時にもテーブルをクリアまたはエラー表示する
        renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput); 
        deteriorationTableBodyElement.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-500">劣化リストの表示中にエラーが発生しました。</td></tr>';
    }
  };

  // Attach the new listener and store it
  console.log(`[setupDeteriorationListener] Attaching new listener for ${listenerKey}`); // ★ 追加ログ
  deteriorationRef.on('value', listenerCallback, (error) => {
    // ★★★ リスナー自体のエラーハンドリング ★★★
    console.error(`[setupDeteriorationListener] <<<< LISTENER ERROR >>>> Error attaching or receiving data for ${listenerKey}:`, error);
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput); 
    deteriorationTableBodyElement.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-500">データのリアルタイム受信に失敗しました。</td></tr>';
     // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★
  });

  deteriorationListeners[listenerKey] = { ref: deteriorationRef, callback: listenerCallback };
  console.log(`[setupDeteriorationListener] Listener attached successfully for ${listenerKey}`); // ★ 追加ログ
}

// ★ 修正: fetchAndRenderDeteriorations にログを追加
async function fetchAndRenderDeteriorations(projectId, buildingId, deteriorationTableBodyElement, nextIdDisplayElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput) {
  console.log(`--- fetchAndRenderDeteriorations START for ${projectId}/${buildingId} ---`); // ★ 追加ログ
  if (!projectId || !buildingId) {
    console.warn("[fetchAndRenderDeteriorations] Missing projectId or buildingId. Clearing table.");
    renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput); 
    updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement); 
    console.log(`--- fetchAndRenderDeteriorations END (Missing IDs) ---`); // ★ 追加ログ
    return;
  }
  console.log(`[fetchAndRenderDeteriorations] Setting up listener and updating next ID for ${projectId}/${buildingId}`);
  try { // ★ 追加: 念のため try...catch
      // Setup real-time listener for deterioration data
      setupDeteriorationListener(projectId, buildingId, deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
      console.log(`[fetchAndRenderDeteriorations] Listener setup initiated for ${projectId}/${buildingId}`); // ★ 追加ログ
      
      // Update the next ID display based on the counter
      await updateNextIdDisplay(projectId, buildingId, nextIdDisplayElement);
      console.log(`[fetchAndRenderDeteriorations] Next ID display updated for ${projectId}/${buildingId}`); // ★ 追加ログ
  } catch (error) {
      console.error(`[fetchAndRenderDeteriorations] <<<< ERROR >>>> Error during setup for ${projectId}/${buildingId}:`, error);
      // エラー発生時のUI処理（例：テーブルをクリア）
      renderDeteriorationTable([], deteriorationTableBodyElement, editModalElement, editIdDisplay, editLocationInput, editDeteriorationNameInput, editPhotoNumberInput);
      deteriorationTableBodyElement.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-500">劣化情報の準備中にエラーが発生しました。</td></tr>';
  }
  console.log(`--- fetchAndRenderDeteriorations END for ${projectId}/${buildingId} ---`); // ★ 追加ログ
}