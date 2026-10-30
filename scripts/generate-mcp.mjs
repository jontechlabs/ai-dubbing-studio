// Generate MCP argument schemas from the same types used by the desktop UI.
// No runtime Node.js or Python dependency is needed by the installed server.
import ts from 'typescript';
import fs from 'node:fs';
import prettier from 'prettier';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, '.');
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const types = new Map();
for (const file of program.getSourceFiles()) {
  if (!file.fileName.replaceAll('\\', '/').includes('/src/') && !file.fileName.startsWith('src/'))
    continue;
  for (const node of file.statements) {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name)
      types.set(node.name.text, checker.getTypeAtLocation(node));
  }
}
function makeSchema(name) {
  const definitions = {};
  const building = new Map();
  function schema(type) {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (type.flags & ts.TypeFlags.StringLiteral) return { type: 'string', const: type.value };
    if (type.flags & ts.TypeFlags.NumberLiteral) return { type: 'number', const: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral)
      return { type: 'boolean', const: type.intrinsicName === 'true' };
    if (type.flags & ts.TypeFlags.StringLike) return { type: 'string' };
    if (type.flags & ts.TypeFlags.NumberLike) return { type: 'number' };
    if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
    if (type.isUnion())
      return { anyOf: type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined)).map(schema) };
    if (checker.isArrayType(type))
      return { type: 'array', items: schema(checker.getTypeArguments(type)[0]) };
    if (checker.isTupleType(type))
      throw Error('Tuple not supported: ' + checker.typeToString(type));
    const key = building.get(type);
    if (key) return { $ref: '#/$defs/' + key };
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const candidate = symbol?.name;
    const named = candidate && !['__type', 'Record', '__object'].includes(candidate);
    const definition = named ? `${candidate}_${Object.keys(definitions).length}` : null;
    if (definition) {
      building.set(type, definition);
      definitions[definition] = {};
    }
    const properties = {},
      required = [];
    for (const property of type.getProperties()) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) throw Error('Missing property declaration: ' + property.name);
      properties[property.name] = schema(checker.getTypeOfSymbolAtLocation(property, declaration));
      if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    const result = {
      type: 'object',
      properties,
      required,
      additionalProperties: index ? schema(index) : false,
    };
    if (definition) {
      definitions[definition] = result;
      return { $ref: '#/$defs/' + definition };
    }
    return result;
  }
  if (!types.has(name)) throw Error('Missing UI type: ' + name);
  const root = schema(types.get(name));
  return { ...root, ...(Object.keys(definitions).length ? { $defs: definitions } : {}) };
}
const mapping = {
 'speaker_separation::Options':'SpeakerSeparationOptions',
 'speaker_separation::Destination':'SpeakerSeparationDestination',
 'speaker_separation::Assignment':'SpeakerDubbingAssignment',
 'audio_toolbox::Options':'AudioToolboxOptions',
 'audio_toolbox::Destination':'AudioToolboxDestination',
  'dubbing_pipeline::Options':'DubbingPipelineOptions',
  'source_transcription::Options': 'SourceTranscriptionOptions',
  'character_match::Options': 'CharacterMatchOptions',
  'voice_library::SourceOptions': 'VoiceLibrarySourceOptions',
  'voice_library::Generation': 'VoiceLibraryGeneration',
  'voice_library::Review': 'VoiceLibraryReview',
  'voice_capture::Options': 'VoiceConversionOptions',
  'prosody::Options': 'ProsodyOptions',
  'tts::Options': 'VoiceSettings',
  'voice_edit::Edit': 'VoiceEdit',
  'lips::Options': 'LipOptions',
  'inpaint::Options': 'InpaintOptions',
  'inpaint_batch::Selection': 'InpaintBatchSelection',
  'tts_batch::Selection': 'DubbingBatchSelection',
  'audio_patch::Options': 'TransferOptions',
  'character_review::Scope': 'SpeakerScope',
  'character_review::PortraitOptions': 'PortraitOptions',
  'character_review::ReferenceSegment': 'ReferenceSegment',
  'local_separation::Options': 'LocalSeparationOptions',
  'audio_fx_job::Options': 'AudioEffectsOptions',
  'mix::Options': 'MkvOptions',
};
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
function rustSchema(type) {
  if (type.startsWith('Vec<') && type.endsWith('>'))
    return { type: 'array', items: rustSchema(type.slice(4, -1)) };
  if (type === 'String') return { type: 'string' };
  if (type === 'bool') return { type: 'boolean' };
  if (['u64', 'u32'].includes(type)) return { type: 'integer', minimum: 0 };
  if (type === 'f64') return { type: 'number' };
  if (type === 'speakers::ReferenceSpan')
    return object({
      startMs: { type: 'integer', minimum: 0 },
      endMs: { type: 'integer', minimum: 1 },
    });
  if (mapping[type]) return makeSchema(mapping[type]);
  throw Error('Unknown native parameter type: ' + type);
}
const readOnly =
  /^(environment|graphics_info|.*_status|.*_result|latest_.*|audio_effects_catalog|.*_path|.*_paths|list_jobs|model_storage_info|model_storage_size|voice_install_space|preview_.*|reference_audio_info|get_waveform)$/;
const notes = {
  transcribe_dialogue_source:
    'Transcribe each source subtitle of a dialogue from the chosen audio track using local Whisper CPU. Returns a job ID. Does not replace subtitles or takes. Read and explicitly review the proposal before applying.',
  source_transcription_result:
    'Read original-language transcription segments, original text/timings and stale status. Silence retains old text. Does not apply anything.',
  latest_source_transcription:
    'Read the latest source-transcription job ID for this dialogue in the open project.',
  apply_source_transcription:
    'Explicitly accept reviewed texts of a source-transcription proposal. Rejects changed source/audio. Preserves cue IDs/timings, target SRT and takes; revokes affected translation approvals. Undoable.',
  set_voice_output_gain:
    'Set whole-take output gain without rewriting its original WAV or local edits. gain 0–4; 1.5 is +50%, 1.75 is +75%. Checks rendered audio before saving, limits boosted peaks, and applies to audition, timeline, WAV and MKV.',
  prepare_voice_library_source:
    'Assemble 1–16 owned original character references or assigned dialogue excerpts, total 5–20 seconds, into a NEW immutable source WAV. Explicitly choose this character and excerpts; existing audio/takes are retained. Returns project.',
  generate_voice_library:
    'Generate 1–12 French reference phrases with installed VoxCPM2 from a prepared character source. Returns job ID, reuses model during this batch and releases it at end/cancellation. Samples are PENDING: audition and require explicit human approval before review/default use. Never replaces dialogue takes.',
  review_voice_library_sample:
    'Approve, withdraw, reject, correct actual transcript or choose an approved default for a character French phrase. Approval/default must follow explicit human selection; generation does not certify quality. Correcting the transcript revokes approval. Existing files/takes remain. Returns project.',
  voice_library_audio_path:
    'Read the local WAV path of a source or sample belonging to a character, for audition. Does not approve it.',
  suggest_dialogue_character:
    'Compare the selected dialogue with ORIGINAL character references using local CAMPPlus/Silero CPU. Returns a job ID; read studio_character_suggestion_result when done. Never assigns automatically. Scores are similarities, not probabilities.',
  character_suggestion_result:
    'Read up to three review-only character candidates, uncertainty and staleness. A suggestion is not an assignment.',
  accept_character_suggestion:
    'Assign one proposed character only after human acceptance. Revalidates audio, references and dialogue snapshot; rejects stale results. Undoable; all takes preserved.',
  separate_audio_region:
    'Re-run local Bandit separation on 0.1–60 seconds of an edited source track. Returns a preview job; original tracks are not changed. Requires the existing speech/music/effects stem tracks. Poll jobs, read studio_local_separation_result and audition its three WAVs before explicit application.',
  apply_local_separation:
    'Apply a successful non-stale local separation preview as one undoable set of audio layers. Replaces all three stem regions when the source is Original; for a stem source, replaces that stem region and adds the other recovered components to their tracks. Source files, other times and historical takes are retained.',
  identify_speakers:
    'Analyze anonymous voice groups on the selected audio track, including its edited content. Optional scope restricts the time range, matches a character reference, and explicitly allows replacing existing assignments. Returns a job; review speakerAnalysis before applying. Pitch describes vocal register, never gender.',
  capture_character_portrait:
    'Capture a proposed character thumbnail from a dialogue/video time, or explicitly crop it. Original video stays unchanged. Automatic face crops are unconfirmed visual suggestions; no identity or gender inference.',
  prepare_character_reference:
    'Prepare a new 1–20 second mono WAV by trimming/concatenating 1–16 existing reference segments. Does not change the project; use the returned VoiceReference with studio_merge_characters. Original reference files are retained. Partial segments require transcript review.',
  preview_character_sample:
    'Render a bounded (maximum 20 seconds) dialogue excerpt from the chosen track including its edits, before track mute/solo/global fader. Returns a local WAV path; never changes source audio or the project.',
  apply_audio_effects:
    'Render local audio effects onto a non-destructive track copy or a replace layer (selection up to 120 seconds). Read studio_audio_effects_catalog for allowed kinds and numeric parameters. Whole-track copies can replace the source in the mix; originals remain unchanged. Poll jobs.',
  audio_effects_catalog:
    'List the 20 local audio effects, parameter bounds/defaults and 12 presets. Voice edit operations also support kind effects.',
  suggest_translation:
    'Propose a local translation without applying it. Optional direction (up to 2000 characters) guides character, register, tone and desired spoken length; subtitle timings are supplied automatically. Poll jobs, review the proposal, then explicitly apply it.',
  convert_voice_timbre:
    'Convert the timbre of any existing voice take, using a stored character/file reference. Local Chatterbox VC, no TTS. Creates another immutable take; poll jobs.',
  transfer_voice_prosody:
    'Experimental CPU contour transfer from dialogue audio or a stored voice reference onto an existing voice take. Creates a new immutable take; originals stay intact. Poll studio_list_jobs.',
  create_project:
    'Create a project under an existing absolute parentPath. source and target are language codes.',
  import_media:
    'Import a local movie into the current project. Returns a background job ID. Poll studio_list_jobs.',
  generate_line:
    'Generate another immutable voice take. Returns a job ID; poll jobs. Does not overwrite previous takes.',
  generate_dubbing_batch:
    'Generate translated lines in all/selected scope with one shared configuration. Optional approvedOnly or unapprovedOnly filters translation approval; they are mutually exclusive. Untranslated lines are always excluded; force creates new takes without removing existing ones. Returns a job ID.',
  preview_dubbing_batch:
    'Preview a dubbing batch before starting. Optional approvedOnly or unapprovedOnly filters translation approval; they are mutually exclusive. Counts include approved and unapproved lines excluded by the chosen filter.',
  start_inpaint_batch:
    'Render independent lip clips per dialogue; preserve the main movie. Returns a job ID.',
  export_mkv:
    'Export the current mix and enabled lip variants to an absolute MKV path. Returns a job ID.',
  history: 'Undo or redo the last saved project operation; direction is undo or redo.',
  install_voice_runtime:
    'Download and install a voice engine in model storage. Returns a job ID; check space first.',
  transcribe_voice_reference:
    'Transcribe the original reference audio locally. language may be auto or ja. Returns a job ID.',
  detect_inpaint_faces:
    'Propose face crops on CPU; profile is auto, live or anime. Poll jobs then read the face result.',
};
const context = object({
  projectId: { type: 'string' },
  expectedRevision: { type: 'integer', minimum: 0 },
});
const projectCommands = new Set(
  'suggest_dialogue_character accept_character_suggestion prepare_voice_library_source generate_voice_library review_voice_library_sample capture_character_portrait prepare_character_reference preview_character_sample separate_audio_region apply_local_separation apply_audio_effects convert_voice_timbre transfer_voice_prosody generate_line generate_dubbing_batch start_inpaint_batch inpaint_lips detect_inpaint_faces transfer_audio analyze_lips suggest_translation identify_speakers transcribe_voice_reference import_voice_reference import_dubbing_reference import_media prepare_proxy import_subtitles import_embedded_subtitles history separate_audio export_mkv export_generation export_audio_track export_subtitles'.split(
    ' ',
  ),
);
for (const command of [
  'transcribe_dialogue_source',
  'apply_source_transcription',
  'separate_dialogue_speakers','speaker_separation_result','speaker_separation_path','apply_speaker_separation_result','create_speaker_dubbings',
  'set_voice_output_gain',
  'generate_dubbing_pipeline', 'separate_audio_selection', 'audio_toolbox_result', 'audio_toolbox_path', 'apply_audio_toolbox_result',
])
  projectCommands.add(command);
const text = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const commands = [];
for (const match of text.matchAll(
  /#\[tauri::command\]\s*(?:async\s+)?fn (\w+)\(([\s\S]*?)\)\s*(?:->[\s\S]*?)?\{/g,
)) {
  const [, command, parameters] = match;
  if (command.startsWith('mcp_') || command === 'replace_project') continue;
  const properties = {},
    required = [];
  // A comma separates parameters only outside Rust generic brackets.
  let depth = 0,
    parameter = '';
  const fields = [];
  for (const char of parameters + ',') {
    if (char === '<') depth++;
    if (char === '>') depth--;
    if (char === ',' && depth === 0) {
      if (parameter.trim()) fields.push(parameter.trim());
      parameter = '';
    } else parameter += char;
  }
  for (const field of fields) {
    const split = field.indexOf(':');
    const name = field.slice(0, split).trim();
    let type = field.slice(split + 1).trim();
    if (type.startsWith('State<') || type === 'tauri::AppHandle') continue;
    const optional = type.startsWith('Option<');
    if (optional) type = type.slice(7, -1);
    const property = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = rustSchema(type);
    properties[property] = optional ? { anyOf: [value, { type: 'null' }] } : value;
    if (!optional) required.push(property);
  }
  // Lift nested $defs so JSON pointers remain local to each tool's input schema.
  const definitions = {};
  function lift(value, prefix) {
    if (Array.isArray(value)) return value.map((v) => lift(v, prefix));
    if (!value || typeof value !== 'object') return value;
    const current = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '$defs')
        for (const [name, schema] of Object.entries(child))
          definitions[prefix + name] = lift(schema, prefix);
      else
        current[key] =
          key === '$ref' ? child.replace('#/$defs/', '#/$defs/' + prefix) : lift(child, prefix);
    }
    return current;
  }
  const inputSchema = {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, lift(value, key + '_')]),
    ),
    required,
    additionalProperties: false,
  };
  if (projectCommands.has(command)) {
    inputSchema.properties.context = context;
    inputSchema.required.push('context');
  }
  if (Object.keys(definitions).length) inputSchema.$defs = definitions;
  commands.push({
    name: 'studio_' + command,
    command,
    description:
      notes[command] ??
      command.replaceAll('_', ' ') +
        '. Uses the current desktop session. Local file paths must be absolute; long operations return job IDs. Existing native validation applies.',
    inputSchema,
    annotations: {
      readOnlyHint: readOnly.test(command),
      destructiveHint: !readOnly.test(command),
      openWorldHint: false,
    },
  });
}
const schemas = Object.fromEntries(
  ['Project', ...new Set(Object.values(mapping)), 'VoiceOperation'].map((name) => [
    name,
    makeSchema(name),
  ]),
);
const string = { type: 'string' },
  bool = { type: 'boolean' },
  integer = { type: 'integer', minimum: 0 };
const choice = (...values) => ({ type: 'string', enum: values });
const builtins = [];
function tool(name, description, properties, required, editing = false, readonly = false) {
  if (editing) {
    properties.context = context;
    required = [...required, 'context'];
  }
  // makeSchema() uses root-relative references. Lift definitions from a
  // structured builtin argument to the enclosing MCP input schema.
  const definitions = {};
  properties = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      const { $defs, ...schema } = value;
      for (const [id, definition] of Object.entries($defs ?? {})) {
        if (definitions[id] && JSON.stringify(definitions[id]) !== JSON.stringify(definition))
          throw Error(`Conflicting schema definition in ${name}: ${id}`);
        definitions[id] = definition;
      }
      return [key, schema];
    }),
  );
  builtins.push({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
      ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
    },
    annotations: { readOnlyHint: readonly, destructiveHint: !readonly, openWorldHint: false },
  });
}
tool(
  'studio_get_state',
  'Read project identity/revision, selection, playback, jobs and UI preferences. Read this before an edit and pass its context to mutations.',
  {},
  [],
  false,
  true,
);
tool(
  'studio_voice_quality_catalog',
  'Read supported generation quality controls, bounds, defaults and model-specific presets. Apply quality in VoiceSettings for single or batch generation. Existing takes are preserved.',
  {},
  [],
  false,
  true,
);
tool(
  'studio_audio_levels',
  'Read live stereo sample-peak/RMS dBFS levels after track gain, regions and effects, before player listening volume. $mix is the summed final mix before export clipping. Reset clears latched clipping and maxima for one track ID or all tracks when id is omitted. This never changes project audio or gain.',
  { action: choice('status', 'reset'), id: string },
  ['action'],
);
tool(
  'studio_get_project',
  'Read the complete saved project JSON. For partial changes prefer the typed editing tools or atomic project patches.',
  {},
  [],
  false,
  true,
);
tool(
  'studio_get_dialogues',
  'Read paginated dialogue texts, translation statuses, selected takes and timing. Maximum 200 rows per response.',
  {
    offset: integer,
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    status: choice('all', 'untranslated', 'translated', 'approved'),
    ids: { type: 'array', items: string },
  },
  [],
  false,
  true,
);
tool(
  'studio_microphone',
  'Record a local microphone take for a dialogue in the open studio. status/start/stop/discard/save. start may require the Windows microphone permission prompt; max 120 seconds. save adds an immutable take. Existing takes stay intact.',
  {
    action: choice('status', 'start', 'stop', 'discard', 'save'),
    lineId: string,
    deviceId: string,
  },
  ['action'],
  true,
);
tool('studio_save', 'Flush pending desktop edits to disk. No project change is discarded.', {}, []);
tool(
  'studio_project_patch',
  'Atomically apply JSON Pointer patches to the current project with validation and undo. add/replace/remove/test supported; Project identity/revision/creation metadata cannot be overwritten. Use test for array IDs. All character, reference, pronunciation, model, subtitle, track and lip settings are editable. Read studio://schemas/Project for the full schema.',
  {
    patches: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'object',
        properties: { op: choice('add', 'replace', 'remove', 'test'), path: string, value: {} },
        required: ['op', 'path'],
        additionalProperties: false,
      },
    },
  },
  ['patches'],
  true,
);
tool(
  'studio_edit_dialogue',
  'Edit source/translated/spoken text; optionally validate the translation. lineId must exist.',
  { lineId: string, role: choice('source', 'target', 'tts'), text: string, approved: bool },
  ['lineId', 'role', 'text'],
  true,
);
tool('studio_add_dialogue','Add a timed dialogue with optional original or translated text (at least one nonempty). Creates independent SRT cues without moving existing lines. Context required; undoable. Read studio_get_project to retrieve its new ID.',{options:makeSchema('NewDialogueOptions')},['options'],true);
tool('studio_set_dialogue_exclusion','Exclude or restore dialogues for dubbing. Preserve source/translated subtitles, every historical take, voice edit and placement. Excluded lines stay outside voice mixing, generation and lip batches. Undoable; unknown IDs reject atomically.',{ids:{type:'array',minItems:1,items:string},excluded:bool},['ids','excluded'],true);
tool(
  'studio_approve_translations',
  'Approve or withdraw the common text and selected-current-voice review for supplied dialogue IDs in one undoable saved edit. Empty translations and stale selected takes are skipped; unknown IDs reject the entire edit. Without a selected take, approve text for batch preparation; a new selected take withdraws that approval. Any text, pronunciation, take, edit or placement change withdraws the common approval. Historical takes are preserved. Read checkedIds from studio_get_state to include checked lines hidden by filters.',
  { ids: { type: 'array', minItems: 1, items: string }, approved: bool },
  ['ids', 'approved'],
  true,
);

tool(
  'studio_set_character_profile',
  'Edit manual gender/temporary-name metadata or a confirmed thumbnail. Gender is explicitly user-provided, never inferred from face or voice.',
  { id: string, changes: makeSchema('CharacterProfile') },
  ['id', 'changes'],
  true,
);
tool(
  'studio_merge_characters',
  'Merge selected character profiles into keepId as one undoable edit. Retains all reference files and historical voice takes; reassigns dialogues. Optionally use a prepared composite reference or select a different default reference and portrait.',
  { options: makeSchema('CharacterMerge') },
  ['options'],
  true,
);
tool(
  'studio_apply_speaker_analysis',
  'Apply the current reviewed voice grouping proposals. Respects its recorded section, audio snapshot and replaceAssigned setting; preserves existing assignments by default. Creates temporary names for unknown groups and reuses the guided reference character.',
  { referenceLabel: string, temporaryPrefix: string },
  [],
  true,
);

tool(
  'studio_retime_dialogue',
  'Set subtitle timing for source, target or both without moving other lines.',
  { lineId: string, startMs: integer, endMs: integer, role: choice('source', 'target', 'both') },
  ['lineId', 'startMs', 'endMs', 'role'],
  true,
);
tool(
  'studio_split_dialogue',
  'Split a subtitle dialogue at a time in milliseconds.',
  { lineId: string, atMs: integer },
  ['lineId', 'atMs'],
  true,
);
tool(
  'studio_merge_dialogue',
  'Merge a dialogue with its following dialogue.',
  { lineId: string },
  ['lineId'],
  true,
);
tool(
  'studio_move_voice',
  'Move the selected generated voice relative to its dialogue. Offset is signed milliseconds. Rejects overlaps and film boundaries.',
  { lineId: string, offsetMs: { type: 'integer' } },
  ['lineId', 'offsetMs'],
  true,
);
tool(
  'studio_resize_voice',
  'Change the generated voice duration while preserving pitch, within the actual free timeline slot.',
  { lineId: string, durationMs: { type: 'integer', minimum: 1, maximum: 120000 } },
  ['lineId', 'durationMs'],
  true,
);
tool(
  'studio_edit_voice',
  'Cut, add silence, stretch, set gain, apply fades or replace an audio effects chain on a generated take. Its original WAV is preserved. Render is checked before committing.',
  {
    id: string,
    startMs: integer,
    endMs: integer,
    operation: structuredClone(schemas.VoiceOperation),
  },
  ['id', 'startMs', 'endMs', 'operation'],
  true,
);
tool(
  'studio_set_track',
  'Change track mute, solo and global gain independently. Global gains range from zero to four (0–400%), independently of region gains.',
  {
    id: string,
    changes: {
      type: 'object',
      properties: { mute: bool, solo: bool, gain: { type: 'number', minimum: 0, maximum: 4 } },
      additionalProperties: false,
    },
  },
  ['id', 'changes'],
  true,
);
tool(
  'studio_audio_region',
  'Paint a gain/mute interval on any audio track, preserving surrounding portions.',
  {
    id: string,
    startMs: integer,
    endMs: integer,
    gain: { type: 'number', minimum: 0, maximum: 2 },
    mute: bool,
  },
  ['id', 'startMs', 'endMs', 'gain', 'mute'],
  true,
);
tool(
  'studio_remove_audio_region',
  'Remove a saved gain/mute region on an audio track.',
  { id: string, regionId: string },
  ['id', 'regionId'],
  true,
);
tool(
  'studio_set_all_audio',
  'Quickly mute or unmute all audio, or one track when trackId is provided.',
  { audible: bool, trackId: string },
  ['audible'],
  true,
);
tool(
  'studio_select_take',
  'Choose a generated voice take for playback and export.',
  { id: string },
  ['id'],
  true,
);
tool(
  'studio_delete_take',
  'Remove a take from the project; native source files are never overwritten by this edit. Undo remains available.',
  { id: string },
  ['id'],
  true,
);
tool(
  'studio_review_take',
  'Validate or invalidate a dialogue voice take.',
  { lineId: string, validated: bool },
  ['lineId', 'validated'],
  true,
);
tool(
  'studio_set_lip_variant',
  'Enable or disable a retouched clip after checking that it matches the current voice and timing.',
  { id: string, enabled: bool },
  ['id', 'enabled'],
  true,
);
tool(
  'studio_select_dialogue',
  'Select and reveal a dialogue in the desktop timeline.',
  { lineId: string },
  ['lineId'],
);
tool(
  'studio_set_selection',
  'Check a list of dialogue IDs for a batch. This replaces the current checked list.',
  { ids: { type: 'array', items: string } },
  ['ids'],
);
tool(
  'studio_playback',
  'Control synchronized playback, original/generated replies or an isolated audio selection. action=selection requires trackId/startMs/endMs and optionally beforeLevels to bypass track and selection volume/mute without saving changes. Selection stops at its end; pause/stop cancels it. Times are milliseconds.',
  {
    action: choice(
      'play',
      'pause',
      'stop',
      'seek',
      'line',
      'original',
      'dub',
      'selection',
      'volume',
      'rate',
      'loop',
    ),
    lineId: string,
    trackId: { type: 'string', minLength: 1 },
    startMs: integer,
    endMs: { type: 'integer', minimum: 1 },
    beforeLevels: bool,
    timeMs: integer,
    value: { type: 'number' },
    enabled: bool,
  },
  ['action'],
);
tool(
  'studio_preferences',
  'Control interface language/theme, selected panel, loop padding and timeline zoom. No arbitrary code or shell commands.',
  {
    language: choice('fr', 'en'),
    theme: choice('dark', 'light'),
    panel: {
      anyOf: [
        choice(
          'import',
          'audio',
          'characters',
          'models',
          'export',
          'settings',
          'jobs',
          'subtitles',
          'alignment',
          'dub',
          'batchDub',
          'lips',
          'inpaint',
          'inpaintBatch',
        ),
        { type: 'null' },
      ],
    },
    paddingMs: { type: 'integer', minimum: 0, maximum: 5000 },
    zoom: {
      anyOf: [
        { type: 'number', minimum: 1 },
        { type: 'string', const: 'fit' },
      ],
    },
  },
  [],
);
tool(
  'studio_updates',
  'Read or check for an app update, start its signed download, change automatic checks, or install a downloaded update. Install requires all processing jobs to finish, saves the project and restarts the app. Download/install return accepted status; poll studio_get_state.updater.',
  { action: choice('status', 'check', 'download', 'install', 'automatic'), enabled: bool },
  ['action'],
);
// Every public schema must be independently resolvable by MCP clients.
function verifyReferences(root) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const parts = node.$ref.startsWith('#/') ? node.$ref.slice(2).split('/') : [];
      const target = parts.reduce(
        (value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')],
        root,
      );
      if (!parts.length || target === undefined)
        throw Error(`Unresolved MCP schema reference: ${node.$ref}`);
    }
    Object.values(node).forEach(visit);
  };
  visit(root);
}
for (const entry of [...commands, ...builtins]) verifyReferences(entry.inputSchema);
Object.values(schemas).forEach(verifyReferences);
const path = 'src/mcp/catalog.json';
const result = await prettier.format(
  JSON.stringify({ protocolVersion: '2025-11-25', commands, builtins, schemas }),
  { ...((await prettier.resolveConfig(path)) ?? {}), parser: 'json' },
);
if (process.argv.includes('--check')) {
  if (fs.readFileSync(path, 'utf8') !== result)
    throw Error('MCP catalog is stale. Run node scripts/generate-mcp.mjs.');
} else {
  fs.mkdirSync('src/mcp', { recursive: true });
  fs.writeFileSync(path, result);
}
console.log(
  `${commands.length} native MCP tools; ${Object.keys(schemas).length} shared schemas verified.`,
);
