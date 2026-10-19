# Synchronisation labiale par lot et éditions audio — v0.18.0

## Lancer un lot

1. Générez les doublages et sélectionnez l’essai à utiliser pour chaque réplique.
2. Dans **Dialogues**, cochez les répliques souhaitées si nécessaire, puis ouvrez **Synchronisation labiale par lot**.
3. Choisissez **Toutes les répliques doublées** ou **Répliques cochées uniquement**. Les répliques sans essai sélectionné sont ignorées, même si leur texte est traduit.
4. Choisissez MuseTalk, LatentSync 1.5 ou 1.6, installez le moteur et sélectionnez votre GPU. Les paramètres de génération sont communs au lot.
5. Dans **Réplique utilisée pour le cadrage**, sélectionnez une réplique, dessinez le visage et le masque puis cliquez sur **Conserver ce cadrage pour la réplique … dans le lot**. Répétez pour les autres plans.
6. Vous pouvez réutiliser les cadrages des variantes déjà enregistrées. Leur priorité est inférieure aux cadrages préparés dans ce panneau. Un cadrage commun pour les autres répliques exige de cocher explicitement **Utiliser le cadrage affiché…**.
7. Vérifiez le bilan : prêtes, sans doublage, déjà synchronisées, sans cadrage, exclues. Les motifs d’exclusion sont consultables. Lancez le lot.

Les cadrages préparés sont conservés dans le panneau jusqu’à sa fermeture, puis dans le journal du lot lorsqu’il démarre et dans les variantes produites. Un cadrage commun ne détecte pas les changements de plan. Aucune détection automatique de visage n’est ajoutée dans cette version.

![Configuration du lot](screenshots/lip-batch-fr.png)

*Interface React réelle ; média synthétique et commandes natives simulées pour la capture. Le GPU affiché n’est pas une mesure matérielle.*

## Fichiers, mémoire et reprise

Chaque dialogue possède son propre fichier vidéo, limité à l’emplacement et à la durée de son doublage actuel. Les entrées du modèle sont extraites dans un dossier temporaire privé ; le modèle ne reçoit jamais le chemin de la vidéo principale. **La vidéo principale, les essais audio et les variantes précédentes restent intacts.**

Les variantes actuelles, même désactivées, sont ignorées par défaut. **Forcer de nouvelles variantes** produit d’autres fichiers sans écraser les précédents. Les résultats restent désactivés pour vérification, sauf si vous cochez **Activer les nouvelles variantes après leur génération**. Cette activation désactive une variante déjà active sur le même intervalle.

Le traitement est séquentiel. Le processus du modèle se termine après chaque dialogue ; la VRAM est libérée entre les éléments. Le modèle vidéo n’est donc pas conservé en mémoire pendant tout le lot. **Traitements** affiche l’avancement et permet d’annuler, puis de reprendre avec **Réessayer**. Les séquences déjà réussies sont conservées ; seules les erreurs et les éléments restants sont repris avec leur configuration enregistrée. Une modification du média, de la prise ou de son timing invalide l’élément concerné.

Le lecteur continue d’utiliser la vidéo principale comme horloge. Les variantes activées sont préchargées et superposées pendant leurs intervalles, puis intégrées à l’export MKV. La fluidité dépend aussi du codec, de la résolution et du stockage ; les limites matérielles de [LatentSync](LATENTSYNC.md) restent applicables.

## Découpe et étirement du doublage

Une erreur FFmpeg a été reproduite avec plusieurs portions fortement raccourcies : RubberBand pouvait produire des échantillons sans horodatage utilisable, puis la concaténation échouait avec **Invalid data found when processing input**. Le rendu reconstruit maintenant les horodatages à partir du numéro d’échantillon. Le cache est renouvelé pour éviter de réutiliser les anciens rendus.

L’éditeur vérifie le rendu audio et son ajustement au créneau **avant d’enregistrer** une modification. En cas d’échec, la version précédente du projet reste en place et un message indique que l’essai d’origine est conservé. **Écouter l’essai d’origine** permet de le contrôler sans appliquer les modifications ; **Restaurer l’audio original** rétablit son montage. Les WAV générés ne sont jamais modifiés.

![Conservation de l’essai d’origine après une erreur simulée](screenshots/voice-edit-recovery-fr.png)

*Capture de l’interface avec une erreur native simulée. La correction FFmpeg est vérifiée séparément avec des WAV synthétiques réels.*

Les anciennes éditions enregistrées peuvent être recalculées avec le nouveau moteur. Une portion volontairement rendue muette ou supprimée reste une édition valide ; utilisez la restauration si vous souhaitez retrouver tout l’essai.

## Affichage des répliques

La liste mesure les hauteurs réelles des cartes multilignes et les recalcule au changement de largeur, de texte ou de filtre. Les identifiants des répliques stabilisent leur position dans la liste virtualisée.

![Répliques multilignes](screenshots/dialogue-layout-fixed-fr.png)

Les validations détaillées et leurs limites sont consignées dans [VALIDATION.md](../VALIDATION.md).
