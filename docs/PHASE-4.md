# Phase 4 — personnages, voix et commandes du studio

## Identifier les locuteurs automatiquement

1. Importez la vidéo et le SRT original, puis le SRT traduit si disponible. Vérifiez les timecodes : l’identification travaille dans les créneaux des répliques existantes.
2. Ouvrez **Modèles → Installer le modèle de locuteurs**. Le studio télécharge environ 70 MiB depuis les sources officielles, vérifie les tailles et les SHA-256, puis installe Python 3.12.10, sherpa-onnx 1.13.8, NumPy 2.2.6 et les deux modèles dans un environnement isolé. Internet est nécessaire pour cette installation ; aucun média n’est envoyé. **Traitements** affiche progression, logs, annulation et nouvelle tentative.
3. Ouvrez **Personnages → Identifier les locuteurs par IA**. La piste Voix de Bandit est privilégiée si elle existe ; sinon la piste audio sélectionnée dans la vidéo est utilisée. L’analyse utilise le CPU et peut être annulée depuis Traitements.
4. Revenez dans Personnages après le traitement. Le résultat indique le nombre de groupes proposés et de répliques sans proposition fiable. Cliquez sur **Créer les personnages et assigner les répliques** pour appliquer.
5. Renommez **Speaker 1**, **Speaker 2**… avec les noms du récit. Modifiez un personnage dans le sélecteur de chaque carte, ou assignez une plage de numéros depuis Personnages. Les affectations déjà faites manuellement sont conservées lors de l’application de nouvelles propositions.

Le moteur **3D-Speaker CAMPPlus** compare des empreintes vocales ; **Silero VAD** écarte les passages sans parole détectée. Il regroupe des voix anonymes et ne connaît ni les noms des personnages, ni leur visage. Les répliques contenant moins d’une seconde de parole exploitable restent sans proposition. Les fenêtres lues sont limitées à 15 secondes ; le film entier n’est pas chargé en mémoire. Au maximum 32 groupes sont proposés ; une comparaison ambiguë reste sans affectation.

Le réglage **Séparer plus ou moins les voix** est facultatif. Une valeur élevée crée davantage de groupes ; la valeur initiale est 0,75. Ce score est une similarité d’empreintes, pas une probabilité d’identité. Le bruit, les émotions, les voix simultanées, les effets de séparation et les sous-titres dont les timecodes sont incorrects peuvent fausser le résultat. Le modèle d’empreintes est entraîné sur VoxCeleb en anglais ; sa qualité sur un film japonais n’est pas établie par nos tests. Vérifiez les propositions et corrigez les affectations.

Une modification du média ou des créneaux rend les anciennes propositions inapplicables. Relancez l’analyse dans ce cas. Une identification échouée ou annulée ne remplace pas les personnages existants. Les fichiers précédents restent conservés pour l’historique.

Sources du moteur : [API d’identification sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html), [3D-Speaker](https://github.com/modelscope/3D-Speaker), [Silero VAD](https://k2-fsa.github.io/sherpa/onnx/vad/silero-vad.html). Le studio utilise les moteurs upstream et les fichiers ONNX officiels inchangés. Les licences et sources sont indiquées dans `workers/SPEAKER-MODEL-LICENSE.txt` ; les fichiers et empreintes sont verrouillés dans `workers/speaker-model.json`.

## Références vocales et corrections manuelles

Les personnages ont un nom, une couleur, plusieurs références audio et une référence par défaut. Les propositions IA apportent un extrait vocal candidat ; écoutez-le et corrigez son **Texte réellement prononcé** avant une future génération TTS.

Dans Personnages, **Importer un audio** accepte WAV, FLAC, MP3, OGG ou M4A ; **Extraire cette réplique** utilise le passage sélectionné, depuis les voix séparées ou la piste originale. FFmpeg crée une copie WAV mono dans le projet. Les extraits importés sont limités aux 20 premières secondes. Les références manuelles doivent durer au moins 0,5 seconde ; une référence si courte peut être insuffisante pour un futur moteur TTS.

Nommez les références, par exemple **Neutre**, **Colère** ou **Chuchotement**, saisissez leur transcription et choisissez celle utilisée par défaut. Leur lecteur permet de vérifier l’extrait. Retirer une référence ou supprimer un personnage est annulable avec Ctrl+Z ; supprimer un personnage retire ses affectations. Les fichiers audio restent présents pour conserver les versions précédentes du projet.

## « Voix non générée » et choix des modèles

**Voix non générée** concerne l’audio du doublage de la réplique. Un SRT original ou traduit peut déjà être chargé et calé sans qu’une voix de doublage existe. Cliquez sur ce statut ou sur **Modèles** pour voir les moteurs.

Bandit et le modèle de locuteurs sont installables et utilisables dans cette version. Le choix **Moteur de voix prévu pour ce projet** enregistre une préférence pour CosyVoice3, Fish Audio S2 ou Qwen3-TTS. Il prépare le projet : leurs téléchargements et la génération vocale restent à implémenter. CosyVoice3 est prévu en phase 5 ; les autres moteurs et le gestionnaire général en phase 6. Le bouton Régénérer reste donc désactivé.

## Ajouter une traduction et utiliser le SRT traduit

Cliquez sur **Ajouter une traduction** dans une carte : l’éditeur ouvre un champ même si cette réplique n’a pas encore de sous-titre cible. Le texte est enregistré dans le projet et inclus dans l’export SRT traduit.

Pour un fichier complet, cliquez sur **SRT traduit**, puis choisissez un fichier SRT ou une piste texte du MKV. Une piste correspondant à la langue cible est présélectionnée lorsqu’elle existe ; vous pouvez choisir une autre piste. Les pistes bitmap nécessitent un OCR futur.

L’option **Caler automatiquement le SRT importé sur l’autre SRT** est activée par défaut. Il faut au moins trois répliques dans chaque SRT. Le SRT déjà présent conserve ses timings. Le calcul travaille dans un Web Worker pour garder l’interface réactive et ne modifie que les correspondances suffisamment fiables. Si le résultat est ambigu, le nouveau fichier reste importé, ses timecodes restent conservés et un message explique pourquoi le calage n’a pas été appliqué. Décochez l’option pour une simple importation.

**Caler les deux SRT** dans la colonne Dialogues, ou **Analyser**, ouvre aussi le calcul avec aperçu et choix de référence. Le calage compare des timecodes ; il ne reconnaît pas la parole et ne crée pas une traduction automatique.

## Pistes audio et sous-titres du lecteur

- Dans la timeline, le **haut-parleur** active/coupe une piste audio ; **S** l’écoute en solo. Plusieurs solos sont possibles. Le panneau Audio conserve les contrôles de volume et d’export WAV.
- L’**œil** sur chaque piste de sous-titres affiche ou masque son texte dans le lecteur. Il ne supprime aucun sous-titre et ne retire pas les blocs de la timeline.
- Le lecteur propose **Sous-titres masqués**, **Original**, **Traduction** ou **Les deux SRT**. Ce choix est sauvegardé avec le projet. Par défaut, la traduction est affichée si elle existe, sinon l’original.

Les sous-titres déjà incrustés dans l’image de la vidéo ne peuvent pas être masqués par ce contrôle. Les voix, musique et effets présents dans la capture sont des pistes séparées de Bandit ; ils ne sont pas des voix TTS générées.

## Compatibilité et phases restantes

Les projets aux formats 1 et 2 continuent à s’ouvrir. Les personnages, références, préférences de moteurs et choix de sous-titres utilisent le **format 3** ; une version antérieure du studio refusera ce format. La sauvegarde précédente et Ctrl+Z permettent de revenir sur les modifications ; conservez le dossier complet du projet pour ses médias et références.

Cette version termine la phase 4 et ajoute l’identification automatique sur les répliques. Il reste **3 phases** : phase 5, génération CosyVoice3 ; phase 6, moteurs supplémentaires et gestionnaire général de modèles ; phase 7, mix/export MKV et langues multiples.

## English quick guide

Install the speaker model from Models, then use Characters to identify anonymous voice groups in the existing subtitle intervals. The CPU worker uses the Bandit speech stem when available, Silero VAD to filter speech and 3D-Speaker CAMPPlus to compute voice embeddings. Apply proposals, rename Speaker 1/2 and correct individual or range assignments. Manual assignments are preserved. Short or uncertain voices remain unassigned; changed media/timings require a new run. The English-trained model’s quality on full multilingual films is unqualified.

Import or extract voice references, edit their actual spoken transcript and choose a default. Manual references are normalized into a mono WAV and limited to 20 seconds. Project format 3 preserves these profiles and subtitle preview preferences.

Import a translated SRT or an embedded text subtitle stream; optional automatic synchronization aligns the imported file against the existing other SRT. Ambiguous results preserve the imported file and its timings. Click Add a translation to type one line manually. Timeline speaker/S controls enable/solo audio; eye controls and the player selector control subtitle visibility without deleting text. Voice not generated means no dubbing audio exists. TTS engine preferences are saved for future phases; generation remains Phase 5 work.

## Dossier des modèles et variantes (0.4.1)

Consultez le [guide du stockage, des pistes et des profils GGUF/FP8](MODELS-AND-STORAGE.md). Le haut-parleur remplace M : allumé = activé, barré = coupé. Les profils TTS sont des préférences préparatoires pour les phases 5 et 6.
