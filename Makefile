IMAGE_NAME=inkpostor-backend

.PHONY: build run stop

build:
	sudo docker build -t $(IMAGE_NAME) .

run:
	sudo docker run -p 3001:3001 -d --env-file .env $(IMAGE_NAME)

stop:
	sudo docker ps -q --filter ancestor=$(IMAGE_NAME) | xargs -r sudo docker kill
