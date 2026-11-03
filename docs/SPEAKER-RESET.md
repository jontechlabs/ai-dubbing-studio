# Remise à zéro des locuteurs et capture des vignettes

Dans **Personnages → Remettre les locuteurs à zéro**, choisissez un des deux modes puis confirmez :

- **Conserver les fiches, vignettes et références vocales** : retire l’analyse et les attributions de toutes les répliques, y compris les sous-doublages de voix isolées. Les fiches, noms, vignettes, références et bibliothèques vocales restent disponibles.
- **Retirer aussi les fiches, vignettes et références des personnages du projet** : retire également ces fiches et leurs bibliothèques. Les fichiers restent sur disque pour les essais historiques et l’annulation. Les références de fichiers audio importés indépendamment des personnages restent disponibles.

Les sous-titres source et traduits, les pistes, le montage et tous les essais de doublage sont conservés. Les essais sélectionnés restent accessibles à l’écoute. Les validations communes liées à l’ancien locuteur repassent à vérifier. **Ctrl+Z** annule l’opération, **Ctrl+Y** la rétablit. Vous pouvez ensuite relancer l’identification sur tout le projet ou une zone. Une tâche en cours empêche la remise à zéro.

## Vignettes identiques pour plusieurs personnages

Il n’est pas nécessaire de relancer l’identification si les attributions des voix sont correctes. La v0.36.0 corrige le choix automatique : la capture utilise une réplique du personnage affiché, avec priorité à celle sélectionnée dans l’éditeur si elle lui appartient. Elle ne reprend plus automatiquement la réplique d’un autre personnage. Un personnage sans réplique exige un choix explicite.

Ouvrez **Choisir ou recadrer la vignette**, vérifiez **Réplique pour la vignette**, puis **Capturer la vignette** pour corriger les anciennes captures. Changer de réplique efface une position vidéo manuelle précédente et reprend le milieu de la nouvelle réplique. Vous pouvez toujours choisir explicitement une autre image ou un cadrage manuel.

Le cadrage automatique repère un visage dans l’image ; il ne prouve pas que ce visage est celui du locuteur. Pour une voix hors champ, des répliques simultanées ou un plan montrant plusieurs visages, choisissez une autre position ou recadrez manuellement. La vidéo principale reste intacte.

## Choisir un visage et prévisualiser la scène

Dans **Choisir ou recadrer la vignette → Prévisualiser la scène et choisir un visage**, le mini lecteur permet de lire, déplacer la position en secondes ou avec le curseur, puis avancer ou reculer de 40 ms. La capture automatique ouvre également cet aperçu. Le lecteur principal est mis en pause ; fermer l’aperçu libère son lecteur vidéo.

Après déplacement, mettez en pause puis cliquez **Actualiser l’image et les visages**. Choisissez le type **Automatique**, **Anime / dessin animé** ou **Personnes filmées**. Les visages détectés apparaissent dans une liste de vignettes **Visage 1, Visage 2…**. Si plusieurs sont présents, choisissez celui du personnage : aucun nom de locuteur n’est reconnu automatiquement.

Vous pouvez aussi dessiner le cadre sur l’image, le déplacer, tirer ses quatre coins ou saisir ses coordonnées en pourcentage. **Image entière** reste disponible, notamment lorsqu’aucun visage n’est détecté. Un cadre vide ou dépassant l’image empêche la capture. **Capturer ce cadrage** utilise l’image, le temps exact et le rectangle que vous venez de choisir. Un changement de position ou de projet invalide l’ancienne proposition ; un résultat arrivé en retard ne la rétablit pas.

La détection réutilise les modèles CPU déjà installés pour les personnages (YuNet et cascade anime). L’[exemple public officiel OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet) sert aux contrôles, sans vidéo personnelle. Les cadres ne constituent pas une reconnaissance d’identité ; une correction manuelle reste possible si le détecteur manque un visage.

## MCP

`studio_reset_speakers` exige le contexte courant et un mode explicite : `assignments` pour conserver les fiches, `characters` pour les retirer. L’opération est atomique et utilise l’historique du studio. Un contexte périmé ou une tâche active est refusé. Le catalogue contient 143 outils ; le format du projet reste 26.

`studio_preview_character_portrait` reçoit `options: { characterId, lineId, atMs, profile }` et le contexte courant. Il retourne le contexte source, une image PNG de lecture seule en cache et la liste des rectangles normalisés. Choisissez un rectangle et passez-le avec `atMs` à `studio_capture_character_portrait`. La prévisualisation ne modifie ni le projet ni la vidéo ; son cache est limité à 32 images.
