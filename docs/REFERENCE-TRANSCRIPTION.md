# Transcrire une référence vocale

Disponible à partir de **v0.7.3**, pour les références de personnages utilisées par Fish S2, CosyVoice3 et Qwen3-TTS.

## Utilisation

1. Sélectionnez la réplique, ouvrez **Personnages**, puis choisissez ou créez son personnage. Utilisez **Assigner la réplique sélectionnée** si elle n'a pas encore de personnage.
2. Dans **Références vocales**, importez un fichier audio ou utilisez **Extraire cette réplique**. L'audio est conservé dans le projet ; l'extrait est limité à 20 secondes. Préférez plusieurs secondes de parole claire d'une seule personne.
3. Pour cette référence, choisissez **Détection automatique**, **japonais**, **français** ou une autre langue proposée, puis **Transcrire automatiquement**. Choisissez la langue réellement parlée dans l'enregistrement, indépendamment de la langue cible du projet.
4. La zone **Traitements** affiche la préparation du modèle, la préparation audio, le chargement et la transcription. Vous pouvez annuler. Après réussite, revenez dans **Personnages** : **Texte réellement prononcé** contient le résultat et reste modifiable.
5. Écoutez la référence, vérifiez le texte et utilisez **Utiliser par défaut** ou choisissez cette référence dans **Doublage → Autre référence du personnage**. Pour une référence japonaise, conservez la transcription japonaise ; ne la remplacez pas par la traduction française.

Le même bouton est disponible directement dans **Doublage** lorsqu'une référence de personnage par défaut ou personnalisée est résolue. La transcription y est affichée ; le lien **Gérer les personnages et les références** permet de la corriger.

Avec **Audio de la réplique actuelle**, le studio utilise toujours le texte du SRT original. S'il est absent, extrayez la réplique en référence de personnage, transcrivez-la et sélectionnez cette référence pour le doublage. La transcription ne modifie pas vos SRT.

![Transcription d'une référence dans Personnages](screenshots/reference-transcription.png)

Capture de l'interface React réelle sous Chrome ; commandes natives et texte japonais simulés pour cette capture. Les tests d'inférence réelle sur un autre extrait japonais sont décrits dans [VALIDATION](../VALIDATION.md).

## Traitement local et stockage

- Whisper **small multilingue Q5_1**, 190 085 487 octets (environ 181 Mio), téléchargé au premier usage depuis le dépôt du mainteneur de whisper.cpp. Taille et SHA-256 sont vérifiés avant utilisation ; une installation valide est réutilisée hors ligne.
- Installation dans **le dossier de modèles configuré / whisper-reference**. Le modèle est déplacé avec les autres modèles lorsque vous changez ce dossier. La taille du dossier inclut ce fichier.
- Inférence locale **sur CPU**, dans un processus séparé qui se ferme après chaque transcription. Elle ne charge pas les modèles TTS et ne réserve pas la VRAM de votre RTX. Aucun fichier audio ni transcription n'est envoyé à un service externe ; seule l'installation du modèle nécessite Internet.
- La langue automatique est déterminée à partir de l'audio. Une référence courte, bruitée ou contenant plusieurs voix peut être mal reconnue : choisissez la langue explicitement ou une autre référence. Une seconde minimum ; maximum 20 secondes.
- La transcription reste dans la langue parlée : elle n'est pas traduite vers la langue cible. Vérifiez particulièrement les noms propres, chiffres et mots coupés. Aucun système de reconnaissance ne garantit une transcription exacte.
- L'annulation, une erreur ou une reconnaissance vide conservent le texte précédent. Une correction manuelle, un changement de référence ou de projet pendant le traitement empêchent l'application d'un résultat périmé. Les tâches interrompues peuvent être relancées si la référence n'a pas changé.

## Aide Fish corrigée

Fish FP8 et GGUF utilisent le clonage **Avec transcription exacte de la référence**. L'aide de CosyVoice **Aucune transcription nécessaire** ne s'affiche plus pour Fish, y compris pour les anciens projets qui avaient conservé le mode interlangue. Une référence absente est signalée séparément d'une transcription manquante. La longueur du texte français à générer, par exemple « Son nom : », ne déclenche pas l'erreur de transcription.

Sources et licences : [Whisper](https://github.com/openai/whisper), [modèle converti](https://huggingface.co/ggerganov/whisper.cpp), [notices](../THIRD-PARTY-NOTICES.txt).
