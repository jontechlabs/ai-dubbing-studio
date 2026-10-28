# Piloter le studio avec une IA via MCP

Le studio fournit **132 outils MCP** en v0.32.0 : 100 commandes natives et 32 commandes d’édition, d’état et de lecture. Le serveur utilise **stdio** et le même exécutable que l’application. Cette intégration pilote **l’application ouverte** ; aucun environnement Node.js ou Python supplémentaire n’est requis pour la connexion.

`studio_audio_levels` mesure les niveaux stéréo en dBFS et permet d’effacer les crêtes maximales/voyants, sans modifier le projet. Les valeurs sont aussi dans `studio_get_state.audioLevels`. [Mesure, mix final et limites](AUDIO-LEVELS.md).

## Connexion

1. Ouvrez le studio, puis **Paramètres → Contrôle IA / MCP**.
2. Cochez **Activer le pilotage MCP local**.
3. Choisissez **JSON** ou **Codex · TOML**, puis **Copier la configuration MCP**.
4. Ajoutez-la dans votre client MCP et redémarrez sa connexion au serveur.

Pour Codex, ajoutez le bloc TOML généré dans `~/.codex/config.toml` ou dans le fichier de configuration du projet. Il fournit `command`, `args` et les délais adaptés au studio. La [documentation officielle Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) décrit ces champs et l’ajout de serveurs stdio. Le studio ne modifie pas automatiquement les réglages du client.

![Activation et configuration MCP](screenshots/mcp-settings-fr.png)

*Interface réelle avec commandes natives simulées pour la capture. Le diagnostic Windows vérifie séparément le SDK officiel avec l’exécutable portable et le WebView réels.*

Les tâches exposent aussi leur [durée active](TASK-DURATION.md) dans `timing.elapsedMs` et l’instant de mesure `timing.observedAtMs`. Les anciennes tâches peuvent ne pas avoir de mesure.

Les [effets audio](AUDIO-EFFECTS.md) sont accessibles avec `studio_audio_effects_catalog` et `studio_apply_audio_effects`. L’opération `effects` de `studio_edit_voice` remplace la chaîne sur une portion de prise ; `studio_set_track` accepte un gain global de 0 à 4 (0–400 %), indépendant des volumes locaux.

## Personnages et séparation locale (v0.29)

`studio_identify_speakers` accepte une portée facultative `scope` : `startMs`, `endMs`, `trackId`, `referenceCharacterId`, `replaceAssigned`. Les propositions sont enregistrées séparément ; `studio_apply_speaker_analysis` les applique après vérification. `studio_set_character_profile` renseigne les métadonnées manuelles. `studio_capture_character_portrait` capture une vignette proposée ou un cadrage explicite, sans modifier la vidéo. `studio_character_asset_path` ne donne accès qu’aux images/références de l’analyse actuellement autorisées.

`studio_preview_character_sample` prépare au plus 20 secondes d’une réplique sur la piste choisie. `studio_prepare_character_reference` recoupe/assemble jusqu’à 16 extraits pour créer un nouveau WAV de 1 à 20 secondes sans modifier le projet. Passez ce résultat à `studio_merge_characters` avec les identifiants des fiches, la fiche conservée et la référence par défaut souhaitée. La fusion conserve les références et les essais, et s’annule en une opération.

`studio_separate_audio_region` lance Bandit sur 0,1 à 60 secondes. Attendez la réussite du job, lisez `studio_local_separation_result`, puis les trois `studio_local_separation_path` pour examiner la préécoute. `studio_apply_local_separation` est une application explicite, refusée si les pistes ont changé ou si un résultat est incomplet. Elle conserve les sources et ajoute un seul groupe de couches annulable. La réidentification après séparation est une demande distincte sur la piste Voix et le même intervalle.

Les mutations exigent le contexte courant ; demandez-le de nouveau après chaque édition. Aucun nom ni genre n’est déduit d’un visage ou d’une voix. Les propositions visuelles et acoustiques restent à vérifier. [Guide illustré et limites](CHARACTER-IDENTIFICATION.md).

## Bibliothèque et proposition de personnage (v0.30)

`studio_prepare_voice_library_source` assemble 5 à 20 secondes d’extraits appartenant à un même personnage dans un nouveau WAV ; `studio_generate_voice_library` ajoute des phrases françaises **à valider** et retourne un job. `studio_voice_library_audio_path` fournit la préécoute. Après décision humaine, `studio_review_voice_library_sample` valide, écarte, corrige la transcription ou choisit un défaut validé. Une correction de transcription retire la validation. Aucun essai de dialogue n’est remplacé.

`studio_suggest_dialogue_character` retourne un job de comparaison CPU avec les références d’origine. Lisez `studio_character_suggestion_result` : candidats, incertitude, périmé ou non. **Aucune assignation automatique** ; après acceptation par l’utilisateur, `studio_accept_character_suggestion` réévalue le contexte puis assigne le personnage. Un résultat périmé est refusé.

Les options de doublage acceptent `referenceMode: "library"` et un `intonationGuide` VoxCPM2 facultatif (`mode: "style"` ou `"hybrid"`, `trackId: "auto"` ou piste choisie). Hybrid exige le texte original exact et n’accepte pas de consignes séparées d’accent/humeur. La continuation française `mode: "zeroShot"` retire ces commandes sur les nouvelles demandes ; les anciens essais restent inchangés. [Parcours, limites et format 21](CHARACTER-VOICE-LIBRARY.md).

## Commandes disponibles

| Domaine | Exemples de commandes |
| --- | --- |
| Projets et médias | Créer/ouvrir un projet, importer la vidéo, choisir ses pistes, préparer un proxy, lire le projet complet |
| Sous-titres et personnages | Import SRT/MKV, édition, validation, découpe/fusion/calage des répliques ; personnages, références et prononciation via les données du projet |
| Modèles et voix | État et installation, espace disque, stockage, périphérique, références audio et transcription, génération unitaire ou par lot |
| Intonation | Disponibilité Praat et transfert expérimental vers un nouvel essai, avec mélodie, rythme et énergie réglables ; [guide](PROSODY-TRANSFER.md) |
| Montage audio | Choix des prises, déplacement, durée, découpe, silence, fondus, volume des pistes et des portions, transferts entre pistes |
| Synchronisation labiale | Analyse, cadrage automatique, rendu unitaire/par lot, consultation et activation des variantes |
| Lecture et interface | Sélection des dialogues et lots, lecture/pause/déplacement, volume, vitesse, boucle, zoom, panneaux, langue et thème |
| Résultats | Export MKV, audio, sous-titres et diagnostic ; état, annulation et reprise des traitements ; vérification et installation des mises à jour |

Les schémas exposent tous les paramètres des commandes. Les champs persistants sans outil spécialisé restent modifiables avec `studio_project_patch`, notamment les réglages de modèles, personnages, références, dictionnaire de prononciation et variantes. Il s’agit d’un pilotage des fonctions et des données du studio, sans simulation de clics.

Les outils suivent la session affichée : les changements sont sauvegardés, annulables et visibles dans l’interface. Commencez par `studio_get_state` ; les commandes qui modifient le projet demandent son `context` contenant `projectId` et `expectedRevision`. En cas de `STALE_REVISION`, relisez l’état et vérifiez les modifications avant de recommencer.

Depuis v0.28.3, `studio_approve_translations` valide ou retire les validations d’un ensemble de répliques en une seule modification annulable. Fournissez `ids`, `approved` (booléen) et `context`. `studio_get_state.checkedIds` fournit la sélection cochée dans l’interface, y compris les répliques masquées par ses filtres. Les traductions vides sont ignorées ; tout identifiant inconnu rejette l’opération entière. Les textes, timings et essais sont conservés. [Guide illustré](BATCH-CACHE-AND-TRANSLATION-REVIEW.md#valider-ou-retirer-plusieurs-validations--v0283).

Exemple de parcours pour une IA : lire l’état, créer ou ouvrir le projet, importer la vidéo et suivre sa tâche, importer les deux SRT, lire les répliques par pages avec `studio_get_dialogues`, proposer/valider leurs traductions, sélectionner les références et le modèle, lancer le lot de doublage puis vérifier les prises et exporter le MKV. Après chaque modification, utilisez le contexte renvoyé ou relisez l’état.

Les générations, installations et exports longs renvoient un identifiant de tâche. Utilisez `studio_list_jobs`, `studio_cancel_job` et `studio_retry_job` pour suivre, annuler ou reprendre. L’annulation d’une requête MCP qui attend dans la file empêche son exécution. Les tâches déjà lancées se gèrent avec leur identifiant ; fermer un client MCP ne les détruit pas.

Les schémas des outils décrivent leurs paramètres. Les ressources `studio://schemas/Project`, `studio://schemas/VoiceSettings` et les autres schémas fournissent les structures complètes. `studio_project_patch` permet des changements atomiques à l’aide des opérations JSON Pointer `add`, `replace`, `remove` et `test`. L’identifiant du projet et les métadonnées de révision ne sont pas modifiables.

Utilisez une opération `test` sur l’identifiant d’une entrée avant de la modifier par indice de tableau. Une liste de patches est limitée à 500 opérations et se valide en une seule modification annulable. Les noms et positions de la timeline sont en millisecondes ; les gains audio utilisent 0 pour le silence, 1 pour 100 % et 2 pour 200 %. Les répliques se lisent par pages de 200 au maximum pour limiter la taille des réponses.

Une demande de retouche vocale vérifie le rendu avant sa sauvegarde. Une erreur, une annulation pendant cette préparation ou une révision devenue obsolète conserve le montage précédent. Le modèle labial traite toujours des séquences indépendantes ; la vidéo principale reste intacte.

Le mode est désactivé au départ, se limite à cet ordinateur et utilise une connexion privée authentifiée entre le relais stdio et l’application. Désactiver MCP coupe les nouvelles commandes et celles encore en attente. Le journal des paramètres affiche les noms et résultats des dernières commandes sans enregistrer les jetons de connexion. Aucun outil n’exécute de shell ou de JavaScript fourni par l’IA.

Une seule instance MCP peut gérer un même profil d’application : une seconde instance ne remplace pas une connexion existante. Le relais retrouve les coordonnées locales après un redémarrage ou une réactivation ; le client doit relire l’état avant de reprendre des modifications. Les traitements déjà acceptés peuvent continuer après une déconnexion et se suivent par leur identifiant. Une réponse perdue après le lancement d’une opération exige de vérifier les tâches et le projet avant de relancer cette opération.

Le SDK TypeScript officiel `@modelcontextprotocol/sdk` 1.32.1 sert uniquement aux tests de compatibilité. Il n’est pas nécessaire sur le PC qui utilise l’application.

Références : [transport stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio), [cycle de vie](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) et [outils MCP](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Les révisions 2025-03-26, 2025-06-18 et 2025-11-25 sont négociées ; les versions ultérieures peuvent utiliser la négociation de compatibilité.

Depuis v0.20.1, le relais quitte le processus à la fermeture du studio, à la désactivation de MCP ou au changement de session, même si le client garde son entrée ouverte. Reconnectez le client après un redémarrage du studio. Le serveur est suspendu avant une mise à jour, puis restauré si son lancement échoue. [Installation bloquée et procédure pour les anciennes versions](INSTALLATION-RECOVERY.md).

Depuis v0.27.1, le transport SSH distant demande aussi la fin explicite de chaque relais après sa réponse. Cela évite leur accumulation si OpenSSH conserve une entrée ouverte alors que le studio reste lancé. Les connexions MCP classiques demeurent persistantes. Le studio et le transport SSH doivent tous deux être à jour : [processus MCP, nettoyage et diagnostic](MCP-PROCESSES.md).

Depuis v0.21.0, `VoiceSettings.mood` accepte les 43 intentions du [catalogue d’interprétation](VOICE-ACTING.md), dont `dying`, `stressed` et `laughing`. Les réglages par réplique et les requêtes par lot les partagent. Un nouveau choix enregistré requiert le format de projet 15 ; le serveur et les workers rejettent les intentions inconnues et celles non prises en charge par Qwen3-TTS Base.

Depuis v0.22.0, les variantes `voxcpm2-bf16` et `chatterbox-multilingual-v3` sont installables et générables, par réplique et en lot. `studio_voice_install_space` accepte `variantId` pour leur contrôle avant installation. Les réglages enregistrés nécessitent le format 16. Chatterbox utilise `mode: "crossLingual"`, `mood: "default"`, `accent: "auto"`. Voir [le guide des nouveaux moteurs](VOXCPM2-CHATTERBOX.md).

Microphone et conversion de timbre (v0.23.0) : voir [le guide local](MICROPHONE-VOICE-CONVERSION.md). `studio_microphone` permet de démarrer/arrêter/abandonner/conserver une prise ; `studio_convert_voice_timbre` accepte l’essai et une référence du personnage ou un fichier importé. La capture doit être autorisée par Windows et reste signalée dans le studio.

Depuis v0.24.0, `studio_suggest_translation` accepte aussi `direction` (facultatif, 2 000 caractères maximum) pour préciser personnage, registre, ton et longueur souhaitée. Le studio transmet les créneaux disponibles au modèle. `studio_translation_result` restitue les consignes utilisées avec la proposition ; appliquer le résultat reste une opération explicite.


`studio_voice_quality_catalog` expose les paramètres de synthèse, leurs bornes, les valeurs standard et les profils de chaque moteur. Le champ `VoiceSettings.quality` est accepté pour la génération individuelle et par lot ; il est conservé avec les essais et nécessite le format de projet 19. [Guide qualité](VOICE-QUALITY.md).

## Transcription source et volume (v0.31)

`studio_transcribe_dialogue_source` produit une proposition locale à relire. Consultez les tâches puis `studio_source_transcription_result` ; appliquez explicitement avec `studio_apply_source_transcription`. `studio_latest_source_transcription` retrouve la dernière analyse. `VoiceSettings.outputGain` et `studio_set_voice_output_gain` règlent les nouveaux essais et les essais existants de 0 à 4 (1,5 = +50%). [Guide, captures et format 22](SOURCE-TRANSCRIPTION-OUTPUT-VOLUME.md).

## Atelier de doublage et boîte à outils audio (v0.32)

Consultez `studio_get_state` et utilisez son `context` récent pour chaque commande du projet. `studio_preview_character_sample` écoute la référence de la réplique sur la piste choisie. Les outils d’édition existants modifient les champs partagés du texte original et de prononciation. `studio_generate_dubbing_pipeline` crée un TTS brut puis un essai ChatterboxVC indépendant ; `guideStrength` vaut 0 par défaut, ou 0–1 pour le guide source expérimental. Le champ interne `conversion.generationId` peut être « pipeline » : le pipeline choisit lui-même la sortie de l’étape précédente. Toutes les étapes achevées et les essais précédents restent conservés, même si une étape suivante échoue ou est annulée.

`studio_audio_toolbox_status` expose modèles, espace requis/disponible et périphériques. `studio_install_audio_toolbox_model` installe un outil explicitement choisi. `studio_separate_audio_selection` traite 100–60000 ms de la piste source et retourne un job. AudioSep exige une description du son (`prompt`, de préférence en anglais). `studio_audio_toolbox_result` indique sorties, contexte périmé et application ; `studio_audio_toolbox_path` fournit chaque WAV pour écoute. `studio_apply_audio_toolbox_result` exige la liste explicite des sorties et destinations (`trackId` ou rôle `speech`, `music`, `sfx`), et un choix explicite `muteSource`. Ne présentez pas les stems instrumentaux Demucs comme une séparation fiable musique/bruitages. Ne supposez pas que la personne a écouté ou accepté un résultat. L’application est annulable et refuse une source modifiée. Le média principal n’est jamais réécrit.
