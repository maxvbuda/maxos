# Hi Max! Great job with compartmentalizing this week. Here is the boilerplate code for a class which we briefly touched on:

class Person:
    # 1. The Constructor: Initializes the object's state
    def __init__(self, first_name, last_name):
        self._first_name = first_name  # sets some variables into private variable frields
        self._last_name = last_name   
        self._times_greeted = 0        

    # 2. A Method: Defines a behavior or action (functions inside a class)
    def introduce(self):
        # You use 'self' to access the object's own data inside methods
        self._times_greeted += 1
        return f"Hi, I'm {self._first_name} {self._last_name}."

# 3. Instantiation: Creating actual objects from the blueprint (this is called an instance - we are creating an instance of the Person class)
my_person = Person("Ada", "Lovelace")

# 4. Calling a method (using the function call that exists where I defined my class)
result = my_person.introduce()

print(result) 
# Output: Hi, I'm Ada Lovelace.


# Usually classes would involve two separate files for compartmentalization - one for creating it (as shown above) and one for using instances of said class

# For your homework this week, here is a video on how classes work: https://www.youtube.com/watch?v=dGXa8Z2H45Q

# Try to implement your own simple classes!
